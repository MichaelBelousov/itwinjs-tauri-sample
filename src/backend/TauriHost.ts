// part of the TauriHost that is in the backend runtime

// NOTE: dying on TileAdmin.ts:165 (p)
// const rpcConcurrency = IpcApp.isValid ? (await IpcApp.callIpcHost("queryConcurrency", "cpu")) : undefined;
// which calls _ipc.invoke which is clearly not reacting correctly

import {
  BeDuration,
  IModelStatus,
  Logger,
  ProcessDetector,
} from "@bentley/bentleyjs-core";
import {
  IModelHost,
  IpcHandler,
  IpcHost,
  NativeHost,
  NativeHostOpts,
} from "@bentley/imodeljs-backend";
import {
  IpcSocketBackend,
  RpcConfiguration,
  RpcInterfaceDefinition,
  IModelError,
  InternetConnectivityStatus,
  IpcListener,
  RemoveFunction,
  NativeAppAuthorizationConfiguration,
} from "@bentley/imodeljs-common";
import { ElectronAuthorizationBackend } from "@bentley/electron-manager/lib/ElectronBackend";
import { EventEmitter } from "events";
import { Tauri, TauriRpcManager } from "../common/TauriHost";
import split from "split";

const loggerCategory = "taurihost-backend";

// TODO: switch to websocket IPC?
class TauriIpcBackend implements IpcSocketBackend {
  public addListener(channel: string, listener: IpcListener): RemoveFunction {
    TauriHost.ipcMain.addListener(channel, listener);
    return () => TauriHost.ipcMain.removeListener(channel, listener);
  }
  public removeListener(channel: string, listener: IpcListener) {
    TauriHost.ipcMain.removeListener(channel, listener);
  }
  public send(channel: string, ...args: any[]): void {
    process.stdout.write(
      JSON.stringify({
        type: "ipc",
        channel,
        args,
        tag: args?.[0]?.id,
      }) + "\n"
    );
  }
  public handle(
    channel: string,
    listener: (evt: any, ...args: any[]) => Promise<any>
  ): RemoveFunction {
    TauriHost.ipcMain.removeHandler(channel); // make sure there's not already a handler registered
    TauriHost.ipcMain.handle(channel, listener);
    return () => TauriHost.ipcMain.removeHandler(channel);
  }
}

/**
 * Options for  [[TauriHost.startup]]
 * @beta
 */
export interface TauriHostOptions {
  /** the path to find web resources  */
  webResourcesPath?: string;
  /** filename for the app's icon, relative to [[webResourcesPath]] */
  iconName?: string;
  /** name of frontend url to open.  */
  frontendURL?: string;
  /** use a development server rather than the "electron" protocol for loading frontend (see https://www.electronjs.org/docs/api/protocol) */
  developmentServer?: boolean;
  /** port number for development server. Default is 3000 */
  frontendPort?: number;
  /** list of RPC interface definitions to register */
  rpcInterfaces?: RpcInterfaceDefinition[];
  /** list of [IpcHandler]($common) classes to register */
  ipcHandlers?: typeof IpcHandler[];
  /** if present, [[NativeHost.authorizationClient]] will be set to an instance of NativeAppAuthorizationBackend and will be initialized. */
  authConfig?: NativeAppAuthorizationConfiguration;
  /** if true, do not attempt to initialize AuthorizationClient on startup */
  noInitializeAuthClient?: boolean;
  applicationName?: never; // this should be supplied in NativeHostOpts
}

/** @beta */
export interface TauriHostOpts extends NativeHostOpts {
  tauriHost?: TauriHostOptions;
}

/** @beta */
export interface TauriHostWindowOptions
  extends Tauri.BrowserWindowConstructorOptions {
  storeWindowName?: string;
  /** The style of window title bar. Default is `default`. */
  titleBarStyle?: "default" | "hidden" | "hiddenInset" | "customButtonsOnHover";
}

/** the size and position of a window as stored in the settings file.
 * @beta
 */
export interface WindowSizeAndPositionProps {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Options for  [[TauriHost.startup]]
 * @beta
 */
export interface TauriHostOptions {
  /** the path to find web resources  */
  webResourcesPath?: string;
  /** filename for the app's icon, relative to [[webResourcesPath]] */
  iconName?: string;
  /** name of frontend url to open.  */
  frontendURL?: string;
  /** use a development server rather than the "electron" protocol for loading frontend (see https://www.electronjs.org/docs/api/protocol) */
  developmentServer?: boolean;
  /** port number for development server. Default is 3000 */
  frontendPort?: number;
  /** list of RPC interface definitions to register */
  rpcInterfaces?: RpcInterfaceDefinition[];
  /** list of [IpcHandler]($common) classes to register */
  ipcHandlers?: typeof IpcHandler[];
  /** if present, [[NativeHost.authorizationClient]] will be set to an instance of NativeAppAuthorizationBackend and will be initialized. */
  authConfig?: NativeAppAuthorizationConfiguration;
  /** if true, do not attempt to initialize AuthorizationClient on startup */
  noInitializeAuthClient?: boolean;
  applicationName?: never; // this should be supplied in NativeHostOpts
}

/** @beta */
export interface TauriHostOpts extends NativeHostOpts {
  tauriHost?: TauriHostOptions;
}

/**
 * The backend for Tauri-based desktop applications
 * @beta
 */
export class TauriHost {
  private static _ipc: TauriIpcBackend;

  public static mainWindow = (() => {
    return new (class extends EventEmitter {
      public async getSize(): Promise<[number, number]> {
        //const size = await TauriApi.window.getCurrent().innerSize();
        //return [size.width, size.height];
        return [0, 0];
      }
      public async getPosition(): Promise<[number, number]> {
        //const pos = await TauriApi.window.getCurrent().innerPosition();
        //return [pos.x, pos.y];
        return [0, 0];
      }
      public setMenuBarVisibility(_b: boolean) {}
      public setAutoHideMenuBar(_b: boolean) {}
    })();
  })();
  public static rpcConfig: RpcConfiguration;

  public static ipcMain = new (class extends EventEmitter {
    public constructor() {
      super();
      IModelHost.onAfterStartup.addOnce(() => {
        process.stdin
          .pipe(split(JSON.parse))
          .on("data", async (json) => {
            const event = undefined;
            const result = await TauriHost.ipcMain.invoke(
              json.channel,
              event,
              ...json.args
            );
            // HACK: rpc has its own listener which will write a response, we should probably do the same for ipc but right now
            // in that case we respond here
            if (json.type === "rpc_send_response") return;
            process.stdout.write(
              JSON.stringify({
                /** I need some kind of primitive sequence tag to allow out-of-order responses */
                tag: json.tag ?? 0,
                result,
              }) + "\n"
            );
          })
          .on("error", (err) => {
            Logger.logError(loggerCategory, err?.message, () => err);
          });
      });
    }
    public invoke(channel: string, _evt?: Event, ...args: any[]): any {
      // FIXME: use this.rawListeners
      const channelListeners = this.listeners(channel);
      if (channelListeners.length === 0)
        throw Error("cannot invoke on unhandled channel");
      if (channelListeners.length > 1)
        // TODO: setMaxListeners()
        throw Error("cannot assign multiple listeners to an invokable channel");
      const [listener] = channelListeners;
      return listener(_evt, ...args);
    }
    public handle = this.addListener;
    public removeHandler = this.removeAllListeners;
  })();

  public static app = (() => {
    return new (class extends EventEmitter {
      public handle(channel: string, listener: (...args: any[]) => any) {
        this.addListener(channel, listener);
      }
      public removeHandler(_channel: string) {}
      public quit() {}
    })();
  })();

  public static tauri = {
    getAllWindows(): Tauri.BrowserWindow[] {
      return [];
    },
    BrowserWindow: class BrowserWindow implements Tauri.BrowserWindow {
      public constructor(_opts: Tauri.BrowserWindowConstructorOptions) {}
      static getAllWindows() {
        TauriHost.tauri.getAllWindows();
      }
    },
  };

  /** @internal */
  public static get authorization() {
    return IModelHost.authorizationClient as ElectronAuthorizationBackend;
  }

  private constructor() {}

  private static async _openWindow(options?: TauriHostWindowOptions) {
    const _opts: Tauri.BrowserWindowConstructorOptions = {
      ...options,
      autoHideMenuBar: true,
      webPreferences: {
        ...options?.webPreferences,

        // These web preference variables should not be overriden by the ElectronHostWindowOptions
        /*
        preload: require.resolve(
          "./TauriPreload.js"
        ),
        */
        experimentalFeatures: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        nativeWindowOpen: true,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
      },
    };

    /** Monitors and saves main window size, position and maximized state */
    if (options?.storeWindowName) {
      const name = options.storeWindowName;
      const saveWindowPosition = async () => {
        const resolution = await this.mainWindow.getSize();
        const position = await this.mainWindow.getPosition();
        const pos: WindowSizeAndPositionProps = {
          width: resolution[0],
          height: resolution[1],
          x: position[0],
          y: position[1],
        };
        NativeHost.settingsStore.setData(
          `windowPos-${name}`,
          JSON.stringify(pos)
        );
      };
      const saveMaximized = async (maximized: boolean) => {
        if (!maximized) await saveWindowPosition();
        NativeHost.settingsStore.setData(`windowMaximized-${name}`, maximized);
      };

      this.mainWindow.on("resized", () => saveWindowPosition());
      this.mainWindow.on("moved", () => saveWindowPosition());
      this.mainWindow.on("maximize", () => saveMaximized(true));
      this.mainWindow.on("unmaximize", () => saveMaximized(false));
    }
  }

  /** Gets window size and position for a window, by name, from settings file, if present */
  public static getWindowSizeSetting(
    windowName: string
  ): WindowSizeAndPositionProps | undefined {
    const saved = NativeHost.settingsStore.getString(`windowPos-${windowName}`);
    return saved
      ? (JSON.parse(saved) as WindowSizeAndPositionProps)
      : undefined;
  }

  /** Gets "window maximized" flag for a window, by name, from settings file if present */
  public static getWindowMaximizedSetting(
    windowName: string
  ): boolean | undefined {
    return NativeHost.settingsStore.getBoolean(`windowMaximized-${windowName}`);
  }

  /**
   * Open the main Window when the app is ready.
   * @param windowOptions Options for constructing the main BrowserWindow. See: https://electronjs.org/docs/api/browser-window#new-browserwindowoptions
   */
  public static async openMainWindow(
    windowOptions?: TauriHostWindowOptions
  ): Promise<void> {
    // replace with tauri equivalent
    const _developmentServer = false;
    if (_developmentServer) {
      // Occasionally, the electron backend may start before the webpack devserver has even started.
      // If this happens, we'll just retry and keep reloading the page.
      this.app.on("web-contents-created", (_e, webcontents) => {
        webcontents.on(
          "did-fail-load",
          async (
            _event: any,
            errorCode: any,
            _errorDescription: any,
            _validatedURL: any,
            isMainFrame: any
          ) => {
            // errorCode -102 is CONNECTION_REFUSED - see https://cs.chromium.org/chromium/src/net/base/net_error_list.h
            if (isMainFrame && errorCode === -102) {
              await BeDuration.wait(500);
              webcontents.reload();
            }
          }
        );
      });
    }

    await this._openWindow(windowOptions);
  }

  public static get isValid() {
    return this._ipc !== undefined;
  }

  /**
   * Initialize the backend of an Electron app.
   * This method configures the backend for all of the inter-process communication (RPC and IPC) for an
   * Electron app. It should be called from your Electron main function.
   * @param opts Options that control aspects of your backend.
   * @note This method must only be called from the backend of an Electron app (i.e. when [ProcessDetector.isElectronAppBackend]($bentley) is `true`).
   */
  public static async startup(opts?: TauriHostOpts) {
    if (!ProcessDetector.isTauriAppBackend)
      throw new Error("Not running under Tauri");

    if (!this.isValid) {
      this._ipc = new TauriIpcBackend();
      this.rpcConfig = TauriRpcManager.initializeBackend(
        this._ipc,
        opts?.tauriHost?.rpcInterfaces
      );
    }

    opts = opts ?? {};
    opts.ipcHost = opts.ipcHost ?? {};
    opts.ipcHost.socket = this._ipc;
    await NativeHost.startup(opts);
    if (IpcHost.isValid) {
      TauriAppHandler.register();
      opts.tauriHost?.ipcHandlers?.forEach((ipc) => ipc.register());
    }

    const authorizationBackend = new ElectronAuthorizationBackend(
      opts.tauriHost?.authConfig
    );
    const connectivityStatus = NativeHost.checkInternetConnectivity();
    if (
      opts.tauriHost?.authConfig &&
      true !== opts.tauriHost?.noInitializeAuthClient &&
      connectivityStatus === InternetConnectivityStatus.Online
    )
      await authorizationBackend.initialize(opts.tauriHost?.authConfig);

    IModelHost.authorizationClient = authorizationBackend;
  }
}

/** @deprecated */
class TauriAppHandler extends IpcHandler {
  public get channelName() {
    return "electron-safe";
  }
  // TODO: rename to call tuari
  public async callElectron(member: string, method: string, ...args: any) {
    const electronMember = (TauriHost.tauri as any)[member];
    const func = electronMember[method];
    if (typeof func !== "function")
      throw new IModelError(
        IModelStatus.FunctionNotFound,
        `Method ${method} not found electron.${member}`
      );

    return func.call(electronMember, ...args);
  }
}
