// FIXME: REMOVE ELECTRON IMPORT
// Note: only import types! Does not create a `require("electron")` in JavaScript after transpiling. That's important so this file can
// be imported by apps that sometimes use Electron and sometimes not.
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcRendererEvent,
} from "electron";
// should really only import this on the frontend...?
//import TauriApi from "@tauri-apps/api";
import * as fs from "fs";
import * as path from "path";
import {
  BeDuration,
  BentleyStatus,
  IModelStatus,
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
  AsyncMethodsOf,
  IpcApp,
  NativeApp,
  NativeAppOpts,
  PromiseReturnType,
} from "@bentley/imodeljs-frontend";
import {
  IModelReadRpcInterface,
  IModelTileRpcInterface,
  IModelWriteRpcInterface,
  IpcSocket,
  IpcSocketBackend,
  IpcSocketFrontend,
  RpcConfiguration,
  RpcInterfaceDefinition,
  RpcManager,
  RpcProtocol,
  SnapshotIModelRpcInterface,
  RpcProtocolEvent,
  RpcRequest,
  RpcRequestFulfillment,
  RpcSerializedValue,
  IModelError,
  SerializedRpcRequest,
  iTwinChannel,
  RpcMarshaling,
  RpcPushChannel,
  RpcPushConnection,
  RpcPushTransport,
  InternetConnectivityStatus,
  RpcInterface,
  IpcListener,
  RemoveFunction,
  NativeAppAuthorizationConfiguration,
} from "@bentley/imodeljs-common";
import { ElectronAuthorizationBackend } from "@bentley/electron-manager/lib/ElectronBackend";
import { PresentationRpcInterface } from "@bentley/presentation-common";

const PUSH = "__push__";

/** @internal */
export class TauriPushTransport extends RpcPushTransport {
  private _ipc: FrontendIpcTransport;
  private _last: number = -1;

  public get last() {
    return this._last;
  }

  public constructor(ipc: FrontendIpcTransport) {
    super();
    this._ipc = ipc;
  }

  public consume(response: RpcRequestFulfillment): boolean {
    if (response.interfaceName !== PUSH) {
      return false;
    }

    this._last = response.status;

    if (this.onMessage) {
      const messageData = RpcMarshaling.deserialize(
        this._ipc.protocol,
        response.result
      );
      this.onMessage(response.id, messageData);
    }

    return true;
  }
}

/** @internal */
export class TauriPushConnection<T> extends RpcPushConnection<T> {
  private _ipc: BackendIpcTransport;
  private _next: number = -1;

  public constructor(
    channel: RpcPushChannel<T>,
    client: unknown,
    ipc: BackendIpcTransport
  ) {
    super(channel, client);
    this._ipc = ipc;
  }

  public async send(messageData: any) {
    const result = await RpcMarshaling.serialize(
      this._ipc.protocol,
      messageData
    );
    const fulfillment: RpcRequestFulfillment = {
      result,
      rawResult: messageData,
      interfaceName: PUSH,
      id: this.channel.id,
      status: ++this._next,
    };
    this._ipc.sendResponse(fulfillment, undefined);
  }
}

const OBJECTS_CHANNEL = iTwinChannel("rpc.objects");
const DATA_CHANNEL = iTwinChannel("rpc.data");

interface PartialPayload {
  id: string;
  index: number;
  data: Uint8Array;
}

/** @internal */
export interface IpcTransportMessage {
  id: string;
  parameters?: RpcSerializedValue;
  result?: RpcSerializedValue;
}

/** @internal */
export abstract class TauriIpcTransport<
  TIn extends IpcTransportMessage = IpcTransportMessage,
  TOut extends IpcTransportMessage = IpcTransportMessage
> {
  private _partials: Map<
    string,
    { message: TIn; received: number } | PartialPayload[]
  >;
  protected _protocol: TauriRpcProtocol;

  public get protocol() {
    return this._protocol;
  }

  public sendRequest(request: SerializedRpcRequest) {
    const value = this._extractValue(request);
    this._send(request, value);
  }

  public constructor(protocol: TauriRpcProtocol) {
    this._protocol = protocol;
    this._partials = new Map();
    this._setupDataChannel();
    this._setupObjectsChannel();
    this.setupPush();
  }

  protected setupPush() {}

  private _setupDataChannel() {
    this.protocol.ipcSocket.addListener(
      DATA_CHANNEL,
      async (evt: any, chunk: PartialPayload) => {
        let pending = this._partials.get(chunk.id);
        if (!pending) {
          pending = [];
          this._partials.set(chunk.id, pending);
        }

        if (Array.isArray(pending)) {
          pending.push(chunk);
        } else {
          ++pending.received;

          const value = this._extractValue(pending.message);
          value.data[chunk.index] = chunk.data;

          if (pending.received === (value.chunks || 0)) {
            this.handleComplete(pending.message.id, evt);
          }
        }
      }
    );
  }

  private _setupObjectsChannel() {
    this.protocol.ipcSocket.addListener(
      OBJECTS_CHANNEL,
      async (evt: any, message: TIn) => {
        const pending = this._partials.get(message.id);
        if (pending && !Array.isArray(pending)) {
          throw new IModelError(
            BentleyStatus.ERROR,
            `Message already received for id "${message.id}".`
          );
        }

        const partial = { message, received: 0 };
        this._partials.set(message.id, partial);
        const value = this._extractValue(partial.message);

        if (pending && Array.isArray(pending)) {
          for (const chunk of pending) {
            ++partial.received;
            value.data[chunk.index] = chunk.data;
          }
        }

        if (partial.received === (value.chunks || 0)) {
          this.handleComplete(message.id, evt);
        }
      }
    );
  }

  private _extractValue(t: IpcTransportMessage): RpcSerializedValue {
    if (t.parameters) {
      return t.parameters;
    }

    if (t.result) {
      return t.result;
    }

    throw new IModelError(BentleyStatus.ERROR, "Unknown value type.");
  }

  private _send(
    message: IpcTransportMessage,
    value: RpcSerializedValue,
    evt?: any
  ) {
    const chunks = value.data;
    if (chunks.length) {
      value.chunks = chunks.length;
      value.data = [];
    }

    this.performSend(OBJECTS_CHANNEL, message, evt);

    for (let index = 0; index !== chunks.length; ++index) {
      const chunk: PartialPayload = {
        id: message.id,
        index,
        data: chunks[index],
      };
      this.performSend(DATA_CHANNEL, chunk, evt);
    }
  }

  protected performSend(channel: string, message: any, evt: any) {
    (evt ? evt.sender : this.protocol.ipcSocket).send(channel, message);
  }

  protected abstract handleComplete(id: string, evt: any): void;

  /** @internal */
  public sendResponse(message: TOut, evt: any) {
    const value = this._extractValue(message);
    this._send(message, value, evt);
  }

  protected loadMessage(id: string) {
    const partial = this._partials.get(id);
    if (!partial || Array.isArray(partial)) {
      throw new IModelError(
        BentleyStatus.ERROR,
        `Incomplete transmission for id "${id}".`
      );
    }

    this._partials.delete(id);
    return partial.message;
  }
}

/** @internal */
export class FrontendIpcTransport extends TauriIpcTransport<RpcRequestFulfillment> {
  private _pushTransport?: TauriPushTransport;

  protected override setupPush() {
    const pushTransport = new TauriPushTransport(this);
    this._pushTransport = pushTransport;
    RpcPushChannel.setup(pushTransport);
  }

  protected async handleComplete(id: string) {
    const message = this.loadMessage(id);

    if (this._pushTransport && this._pushTransport.consume(message)) {
      return;
    }

    const protocol = this._protocol;
    const request = protocol.requests.get(message.id) as TauriRpcRequest;
    request.notifyResponse(message);
  }
}

/** @internal */
export class BackendIpcTransport extends TauriIpcTransport<
  SerializedRpcRequest,
  RpcRequestFulfillment
> {
  private _browserWindow: any;

  protected override setupPush() {
    RpcPushConnection.for = (channel, client) =>
      new TauriPushConnection(channel, client, this);
    RpcPushChannel.enabled = true;
  }

  protected async handleComplete(id: string, evt: any) {
    const message = this.loadMessage(id);

    let response: RpcRequestFulfillment;
    try {
      const protocol = this._protocol;
      response = await protocol.fulfill(message);
    } catch (err) {
      response = await RpcRequestFulfillment.forUnknownError(message, err);
    }

    const raw = response.rawResult;
    response.rawResult = undefined; // Otherwise, it will be serialized in IPC layer and large responses will then crash the app
    this.sendResponse(response, evt);
    response.rawResult = raw;
  }

  protected override performSend(channel: string, message: any, evt: any) {
    if (evt) {
      return super.performSend(channel, message, evt);
    }

    this._requireBrowserWindow();
    const target = TauriRpcConfiguration.targetWindowId;
    const windows = target
      ? [this._browserWindow.fromId(target)]
      : this._browserWindow.getAllWindows();
    windows.forEach((window: any) => window.webContents.send(channel, message));
  }

  private _requireBrowserWindow() {
    if (this._browserWindow) {
      return;
    }

    try {
      // Wrapping require in a try/catch signals to webpack that this is only an optional dependency
      this._browserWindow = require("electron").BrowserWindow; // eslint-disable-line @typescript-eslint/no-var-requires
    } catch (err) {
      throw new IModelError(
        BentleyStatus.ERROR,
        `Error requiring electron`,
        undefined,
        undefined,
        () => err
      );
    }
  }
}

let transport: TauriIpcTransport | undefined;

/** @internal */
export function initializeIpc(protocol: TauriRpcProtocol) {
  if (undefined === transport)
    transport = ProcessDetector.isTauriAppFrontend
      ? new FrontendIpcTransport(protocol)
      : new BackendIpcTransport(protocol);
  return transport;
}

/** @beta */
export class TauriRpcRequest extends RpcRequest {
  private _res: (value: number) => void = () => undefined;
  private _fulfillment: RpcRequestFulfillment | undefined = undefined;

  /** Convenience access to the protocol of this request. */
  public override readonly protocol: TauriRpcProtocol = this.client
    .configuration.protocol as any;

  /** Sends the request. */
  protected async send() {
    try {
      this.protocol.requests.set(this.id, this);
      const request = await this.protocol.serialize(this);
      this.protocol.transport.sendRequest(request);
    } catch (e) {
      this.protocol.events.raiseEvent(
        RpcProtocolEvent.ConnectionErrorReceived,
        this
      );
    }

    return new Promise<number>((resolve) => {
      this._res = resolve;
    });
  }

  /** Loads the request. */
  protected async load() {
    const fulfillment = this._fulfillment;
    if (!fulfillment) {
      throw new Error("No request fulfillment available.");
    }

    return fulfillment.result;
  }

  /** Sets request header values. */
  protected setHeader(_name: string, _value: string): void {
    // No implementation
  }

  /** @internal */
  public notifyResponse(fulfillment: RpcRequestFulfillment) {
    this._fulfillment = fulfillment;
    this._res(fulfillment.status);
  }

  /** @internal */
  public override dispose() {
    this.protocol.requests.delete(this.id);
    super.dispose();
  }
}
/** RPC interface protocol for an Tauri-based application.
 * @beta
 */
export class TauriRpcProtocol extends RpcProtocol {
  public static instances: Map<string, TauriRpcProtocol> = new Map();
  public ipcSocket: IpcSocket;

  /** The RPC request class for this protocol. */
  public readonly requestType = TauriRpcRequest;

  /** Specifies where to break large binary request payloads. */
  public override transferChunkThreshold = 48 * 1024 * 1024;

  /** @internal */
  public requests: Map<string, TauriRpcRequest> = new Map();

  /** @internal */
  public readonly transport: TauriIpcTransport<
    IpcTransportMessage,
    IpcTransportMessage
  >;

  /** Constructs a Tauri protocol. */
  public constructor(
    configuration: TauriRpcConfiguration,
    ipcSocket: IpcSocket
  ) {
    super(configuration);
    this.ipcSocket = ipcSocket;
    this.transport = initializeIpc(this);
  }

  /** @internal */
  public override onRpcClientInitialized(
    definition: RpcInterfaceDefinition,
    _client: RpcInterface
  ): void {
    this.registerInterface(definition);
  }

  /** @internal */
  public override onRpcImplInitialized(
    definition: RpcInterfaceDefinition,
    _impl: RpcInterface
  ): void {
    this.registerInterface(definition);
  }

  /** @internal */
  public override onRpcClientTerminated(
    definition: RpcInterfaceDefinition,
    _client: RpcInterface
  ): void {
    this.purgeInterface(definition);
  }

  /** @internal */
  public override onRpcImplTerminated(
    definition: RpcInterfaceDefinition,
    _impl: RpcInterface
  ): void {
    this.purgeInterface(definition);
  }

  private registerInterface(definition: RpcInterfaceDefinition) {
    if (TauriRpcProtocol.instances.has(definition.interfaceName))
      throw new IModelError(
        BentleyStatus.ERROR,
        `RPC interface "${definition.interfaceName}"" is already associated with a protocol.`
      );

    TauriRpcProtocol.instances.set(definition.interfaceName, this);
  }

  private purgeInterface(definition: RpcInterfaceDefinition) {
    TauriRpcProtocol.instances.delete(definition.interfaceName);
  }
}
/** RPC interface configuration for a Tauri-based application.
 * @internal
 */
export abstract class TauriRpcConfiguration extends RpcConfiguration {
  public static targetWindowId?: number;

  /** The protocol of the configuration. */
  public abstract override protocol: TauriRpcProtocol;
}

/** Coordinates usage of RPC interfaces for an Tauri-based application.
 * @internal
 */
export class TauriRpcManager extends RpcManager {
  /** Initializes TauriRpcManager for the frontend of an application. */
  public static initializeFrontend(
    ipcFrontend: IpcSocketFrontend,
    interfaces?: RpcInterfaceDefinition[]
  ): TauriRpcConfiguration {
    return TauriRpcManager.performInitialization(ipcFrontend, interfaces);
  }

  /** Initializes ElectronRpcManager for the backend of an application. */
  public static initializeBackend(
    ipcBackend: IpcSocketBackend,
    interfaces?: RpcInterfaceDefinition[]
  ): TauriRpcConfiguration {
    return TauriRpcManager.performInitialization(ipcBackend, interfaces);
  }

  private static performInitialization(
    ipcSocket: IpcSocket,
    rpcs?: RpcInterfaceDefinition[]
  ): TauriRpcConfiguration {
    const interfaces = rpcs ?? [
      IModelReadRpcInterface,
      IModelTileRpcInterface,
      IModelWriteRpcInterface,
      SnapshotIModelRpcInterface,
      PresentationRpcInterface,
    ];
    const config = class extends TauriRpcConfiguration {
      public interfaces = () => interfaces;
      public protocol: TauriRpcProtocol = new TauriRpcProtocol(this, ipcSocket);
    };

    for (const def of interfaces) {
      RpcConfiguration.assign(def, () => config);
    }

    const instance = RpcConfiguration.obtain(config);
    RpcConfiguration.initializeInterfaces(instance);

    return instance;
  }
}

class TauriIpcBackend implements IpcSocketBackend {
  public addListener(channel: string, listener: IpcListener): RemoveFunction {
    TauriHost.ipcMain.addListener(channel, listener);
    return () => TauriHost.ipcMain.removeListener(channel, listener);
  }
  public removeListener(channel: string, listener: IpcListener) {
    TauriHost.ipcMain.removeListener(channel, listener);
  }
  public send(channel: string, ...args: any[]): void {
    const window =
      TauriHost.mainWindow ??
      TauriHost.electron.BrowserWindow.getAllWindows()[0];
    window?.webContents.send(channel, ...args);
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

type TauriListener = (event: IpcRendererEvent, ...args: any[]) => void;

/** These methods are stored on `window.itwinjs` */
export interface ITwinTauriApi {
  addListener: (channel: string, listener: TauriListener) => void;
  removeListener: (channel: string, listener: TauriListener) => void;
  invoke: (channel: string, ...data: any[]) => Promise<any>;
  once: (
    channel: string,
    listener: (event: any, ...args: any[]) => void
  ) => void;
  send: (channel: string, ...data: any[]) => void; // only valid for render -> main
}

class TauriIpcFrontend implements IpcSocketFrontend {
  private _api: ITwinTauriApi;
  public addListener(channelName: string, listener: IpcListener) {
    this._api.addListener(channelName, listener);
    return () => this._api.removeListener(channelName, listener);
  }
  public removeListener(channelName: string, listener: IpcListener) {
    this._api.removeListener(channelName, listener);
  }
  public send(channel: string, ...data: any[]) {
    this._api.send(channel, ...data);
  }
  public async invoke(channel: string, ...args: any[]) {
    return this._api.invoke(channel, ...args);
  }
  constructor() {
    // use the methods on window.itwinjs exposed by ElectronPreload.ts, or ipcRenderer directly if running with nodeIntegration=true (**only** for tests).
    // Note that `require("electron")` doesn't work with nodeIntegration=false - that's what it stops
    this._api = (window as any).itwinjs ?? require("electron").ipcRenderer; // eslint-disable-line @typescript-eslint/no-var-requires
  }
}

/** @beta */
export type TauriAppOpts = NativeAppOpts;

/**
 * Frontend of an Electron App.
 * @beta
 */
export class TauriApp {
  private static _ipc?: TauriIpcFrontend;
  public static get isValid(): boolean {
    return undefined !== this._ipc;
  }

  /**
   * Start the frontend of an Electron application.
   * @param opts Options for your ElectronApp
   * @note This method must only be called from the frontend of an Electron app (i.e. when [ProcessDetector.isTauriAppFrontend]($bentley) is `true`).
   */
  public static async startup(opts?: TauriAppOpts) {
    if (!ProcessDetector.isTauriAppFrontend)
      throw new Error("Not running under Electron");
    if (!this.isValid) {
      this._ipc = new TauriIpcFrontend();
      TauriRpcManager.initializeFrontend(
        this._ipc,
        opts?.iModelApp?.rpcInterfaces
      );
    }
    await NativeApp.startup(this._ipc!, opts);
  }

  public static async shutdown() {
    this._ipc = undefined;
    await NativeApp.shutdown();
  }

  /**
   * Call an asynchronous method in the [Electron.Dialog](https://www.electronjs.org/docs/api/dialog) interface from a previously initialized ElectronFrontend.
   * @param methodName the name of the method to call
   * @param args arguments to method
   */
  public static async callDialog<T extends AsyncMethodsOf<Electron.Dialog>>(
    methodName: T,
    ...args: Parameters<Electron.Dialog[T]>
  ) {
    return IpcApp.callIpcChannel(
      "electron-safe",
      "callElectron",
      "dialog",
      methodName,
      ...args
    ) as PromiseReturnType<Electron.Dialog[T]>;
  }
  /**
   * Call an asynchronous method in the [Electron.shell](https://www.electronjs.org/docs/api/shell) interface from a previously initialized ElectronFrontend.
   * @param methodName the name of the method to call
   * @param args arguments to method
   */
  public static async callShell<T extends AsyncMethodsOf<Electron.Shell>>(
    methodName: T,
    ...args: Parameters<Electron.Shell[T]>
  ) {
    return IpcApp.callIpcChannel(
      "electron-safe",
      "callElectron",
      "shell",
      methodName,
      ...args
    ) as PromiseReturnType<Electron.Shell[T]>;
  }
  /**
   * Call an asynchronous method in the [Electron.app](https://www.electronjs.org/docs/api/app) interface from a previously initialized ElectronFrontend.
   * @param methodName the name of the method to call
   * @param args arguments to method
   */
  public static async callApp<T extends AsyncMethodsOf<Electron.App>>(
    methodName: T,
    ...args: Parameters<Electron.App[T]>
  ) {
    return IpcApp.callIpcChannel(
      "electron-safe",
      "callElectron",
      "app",
      methodName,
      ...args
    ) as PromiseReturnType<Electron.App[T]>;
  }
}

/**
 * Options for  [[ElectronHost.startup]]
 * @beta
 */
export interface ElectronHostOptions {
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
  tauriHost?: ElectronHostOptions;
}

/** @beta */
export interface ElectronHostWindowOptions
  extends BrowserWindowConstructorOptions {
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

declare module "@bentley/bentleyjs-core" {
  namespace ProcessDetector {
    /** Is this process the backend of a Tauri app? */
    const isTauriAppBackend: boolean;
    /** Is this process the frontend of a Tauri app? */
    const isTauriAppFrontend: boolean;
  }
}

Object.defineProperty(ProcessDetector, "isTauriAppBackend", {
  get() {
    return (
      // right now it's tauri because I say so
      true
      //typeof process === "object" && process.versions.hasOwnProperty("electron")
    );
  },
});

Object.defineProperty(ProcessDetector, "isTauriAppFrontend", {
  get() {
    return "__TAURI__" in window;
  },
});

/**
 * The backend for Tauri-based desktop applications
 * @beta
 */
export class TauriHost {
  private static _ipc: TauriIpcBackend;
  private static _developmentServer: boolean;
  private static _electron: typeof Electron;
  private static _electronFrontend = "electron://frontend/";
  private static _mainWindow?: BrowserWindow;
  public static webResourcesPath: string;
  public static appIconPath: string;
  public static frontendURL: string;
  public static rpcConfig: RpcConfiguration;
  public static get ipcMain() {
    return this._electron.ipcMain;
  }
  public static get app() {
    return this._electron.app;
  }
  public static get electron() {
    return this._electron;
  }

  /** @internal */
  public static get authorization() {
    return IModelHost.authorizationClient as ElectronAuthorizationBackend;
  }

  private constructor() {}

  /**
   * Converts an "electron://frontend/" URL to an absolute file path.
   *
   * We use this protocol in production builds because our frontend must be built with absolute URLs,
   * however, since we're loading everything directly from the install directory, we cannot know the
   * absolute path at build time.
   */
  private static parseElectronUrl(requestedUrl: string): string {
    // Note that the "frontend/" path is arbitrary - this is just so we can handle *some* relative URLs...
    let assetPath = requestedUrl.substr(this._electronFrontend.length);
    if (assetPath.length === 0) assetPath = "index.html";
    assetPath = path.normalize(`${this.webResourcesPath}/${assetPath}`);
    // File protocols don't follow symlinks, so we need to resolve this to a real path.
    // However, if the file doesn't exist, it's fine to return an invalid path here - the request will just fail with net::ERR_FILE_NOT_FOUND
    try {
      assetPath = fs.realpathSync(assetPath);
    } catch (error) {
      // eslint-disable-next-line no-console
      // console.warn(`WARNING: Frontend requested "${requestedUrl}", but ${assetPath} does not exist`);
    }
    if (!assetPath.startsWith(this.webResourcesPath))
      throw new Error(
        `Access to files outside installation directory (${this.webResourcesPath}) is prohibited`
      );
    return assetPath;
  }

  private static _openWindow(options?: ElectronHostWindowOptions) {
    const opts: BrowserWindowConstructorOptions = {
      ...options,
      autoHideMenuBar: true,
      icon: this.appIconPath,
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

    this._mainWindow = new this.electron.BrowserWindow(opts);
    TauriRpcConfiguration.targetWindowId = this._mainWindow.id;
    this._mainWindow.on("closed", () => (this._mainWindow = undefined));
    this._mainWindow.loadURL(this.frontendURL); // eslint-disable-line @typescript-eslint/no-floating-promises

    /** Monitors and saves main window size, position and maximized state */
    if (options?.storeWindowName) {
      const mainWindow = this._mainWindow;
      const name = options.storeWindowName;
      const saveWindowPosition = () => {
        const resolution = mainWindow.getSize();
        const position = mainWindow.getPosition();
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
      const saveMaximized = (maximized: boolean) => {
        if (!maximized) saveWindowPosition();
        NativeHost.settingsStore.setData(`windowMaximized-${name}`, maximized);
      };

      mainWindow.on("resized", () => saveWindowPosition());
      mainWindow.on("moved", () => saveWindowPosition());
      mainWindow.on("maximize", () => saveMaximized(true));
      mainWindow.on("unmaximize", () => saveMaximized(false));
    }
  }

  /** The "main" BrowserWindow for this application. */
  public static get mainWindow() {
    return this._mainWindow;
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
    windowOptions?: ElectronHostWindowOptions
  ): Promise<void> {
    const app = this.app;
    // quit the application when all windows are closed (unless we're running on MacOS)
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    // re-open the main window if it was closed and the app is re-activated (this is the normal MacOS behavior)
    app.on("activate", () => {
      if (!this._mainWindow) this._openWindow(windowOptions);
    });

    if (this._developmentServer) {
      // Occasionally, the electron backend may start before the webpack devserver has even started.
      // If this happens, we'll just retry and keep reloading the page.
      app.on("web-contents-created", (_e, webcontents) => {
        webcontents.on(
          "did-fail-load",
          async (
            _event,
            errorCode,
            _errorDescription,
            _validatedURL,
            isMainFrame
          ) => {
            // errorCode -102 is CONNECTION_REFUSED - see https://cs.chromium.org/chromium/src/net/base/net_error_list.h
            if (isMainFrame && errorCode === -102) {
              await BeDuration.wait(100);
              webcontents.reload();
            }
          }
        );
      });
    }

    await app.whenReady();

    if (!this._developmentServer) {
      // handle any "electron://" requests and redirect them to "file://" URLs
      this.electron.protocol.registerFileProtocol(
        "electron",
        (request, callback) => callback(this.parseElectronUrl(request.url))
      ); // eslint-disable-line @typescript-eslint/no-var-requires
    }

    this._openWindow(windowOptions);
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
      this._electron = require("electron");
      this._ipc = new TauriIpcBackend();
      const app = this.app;
      if (!app.isReady())
        this.electron.protocol.registerSchemesAsPrivileged([
          { scheme: "electron", privileges: { standard: true, secure: true } },
        ]);
      const eopt = opts?.tauriHost;
      this._developmentServer = eopt?.developmentServer ?? false;
      const frontendPort = eopt?.frontendPort ?? 3000;
      this.webResourcesPath = eopt?.webResourcesPath ?? "";
      this.frontendURL =
        eopt?.frontendURL ??
        (this._developmentServer
          ? `http://localhost:${frontendPort}`
          : `${this._electronFrontend}index.html`);
      this.appIconPath = path.join(
        this.webResourcesPath,
        eopt?.iconName ?? "appicon.ico"
      );
      this.rpcConfig = TauriRpcManager.initializeBackend(
        this._ipc,
        eopt?.rpcInterfaces
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

class TauriAppHandler extends IpcHandler {
  public get channelName() {
    return "electron-safe";
  }
  public async callElectron(member: string, method: string, ...args: any) {
    const electronMember = (TauriHost.electron as any)[member];
    const func = electronMember[method];
    if (typeof func !== "function")
      throw new IModelError(
        IModelStatus.FunctionNotFound,
        `Method ${method} not found electron.${member}`
      );

    return func.call(electronMember, ...args);
  }
}
