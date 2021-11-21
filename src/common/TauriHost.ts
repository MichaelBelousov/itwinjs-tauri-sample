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
import { EventEmitter } from "events";
import type { IpcRendererEvent as ElectronIpcRendererEvent } from "electron";
// TODO: split into frontend-only import
import * as TauriApi from "@tauri-apps/api";

namespace Tauri {
  export interface BrowserWindow
    extends Partial<import("electron").BrowserWindow> {}

  export interface BrowserWindowConstructorOptions
    extends Partial<import("electron").BrowserWindowConstructorOptions> {}

  export interface IpcRendererEvent extends ElectronIpcRendererEvent {}
}

const PUSH = "__push__";

/** @internal */
export class TauriPushTransport extends RpcPushTransport {
  private _ipc: TauriFrontendIpcTransport;
  private _last: number = -1;

  public get last() {
    return this._last;
  }

  public constructor(ipc: TauriFrontendIpcTransport) {
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
  private _ipc: TauriBackendIpcTransport;
  private _next: number = -1;

  public constructor(
    channel: RpcPushChannel<T>,
    client: unknown,
    ipc: TauriBackendIpcTransport
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
  private _partials = new Map<
    string,
    { message: TIn; received: number } | PartialPayload[]
  >();

  public sendRequest(request: SerializedRpcRequest) {
    const value = this._extractValue(request);
    this._send(request, value);
  }

  public constructor(public readonly protocol: TauriRpcProtocol) {
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
    process.stdout.write(
      JSON.stringify({
        type: "sendResponse",
        message,
        evt,
      }) + "\n"
    );
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
export class TauriFrontendIpcTransport extends TauriIpcTransport<RpcRequestFulfillment> {
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

    const request = this.protocol.requests.get(message.id) as TauriRpcRequest;
    request.notifyResponse(message);
  }
}

/** @internal */
export class TauriBackendIpcTransport extends TauriIpcTransport<
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
      response = await this.protocol.fulfill(message);
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

    const target = TauriRpcConfiguration.targetWindowId;
    const windows = target
      ? [this._browserWindow.fromId(target)]
      : this._browserWindow.getAllWindows();
    windows.forEach((window: any) => window.webContents.send(channel, message));
  }
}

let transport: TauriIpcTransport | undefined;

/** @internal */
export function initializeIpc(protocol: TauriRpcProtocol) {
  if (undefined === transport)
    transport = ProcessDetector.isTauriAppFrontend
      ? new TauriFrontendIpcTransport(protocol)
      : new TauriBackendIpcTransport(protocol);
  return transport;
}

/** @beta */
export class TauriRpcRequest extends RpcRequest {
  private _res: (value: number) => void = () => undefined;
  private _fulfillment: RpcRequestFulfillment | undefined = undefined;

  /** Convenience access to the protocol of this request. */
  public override readonly protocol: TauriRpcProtocol = this.client
    .configuration.protocol as TauriRpcProtocol;

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
    process.stdout.write(
      JSON.stringify({
        type: "ipc",
        channel,
        args,
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

type TauriListener = (event: Tauri.IpcRendererEvent, ...args: any[]) => void;

// FIXME: not true the preload is no longer used!
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
  private static checkPrefix(channel: string) {
    if (!channel.startsWith("itwin."))
      throw new Error(`illegal channel name '${channel}'`);
  }

  // NOTE: this replaces the electron preload script
  private api = (() =>
    new (class extends EventEmitter implements ITwinTauriApi {
      send(channel: string, ...data: any[]) {
        TauriIpcFrontend.checkPrefix(channel);
        TauriApi.invoke("ipcRenderer.send", {
          type: "ipcRenderer.send",
          channel,
          args: data,
        });
      }
      public override addListener(channel: string, listener: TauriListener) {
        TauriIpcFrontend.checkPrefix(channel);
        return super.addListener(channel, listener);
      }
      public override removeListener(channel: string, listener: TauriListener) {
        TauriIpcFrontend.checkPrefix(channel);
        return super.removeListener(channel, listener);
      }
      public override once(channel: string, listener: TauriListener) {
        TauriIpcFrontend.checkPrefix(channel);
        return super.once(channel, listener);
      }
      async invoke(channel: string, ...data: any[]): Promise<any> {
        TauriIpcFrontend.checkPrefix(channel);
        TauriApi.invoke("ipcRenderer.invoke", {
          type: "ipcRenderer.invoke",
          channel,
          args: data,
        });
      }
    })())();

  public addListener(channelName: string, listener: IpcListener) {
    this.api.addListener(channelName, listener);
    return () => this.api.removeListener(channelName, listener);
  }
  public removeListener(channelName: string, listener: IpcListener) {
    this.api.removeListener(channelName, listener);
  }
  public send(channel: string, ...data: any[]) {
    this.api.send(channel, ...data);
  }
  public async invoke(channel: string, ...args: any[]) {
    return this.api.invoke(channel, ...args);
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
   * @deprecated
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
   * @deprecated
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
   * @deprecated
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

  public static mainWindow = (() => {
    return new (class extends EventEmitter {
      public async getSize(): Promise<[number, number]> {
        const size = await TauriApi.window.getCurrent().innerSize();
        return [size.width, size.height];
      }
      public async getPosition(): Promise<[number, number]> {
        const pos = await TauriApi.window.getCurrent().innerPosition();
        return [pos.x, pos.y];
      }
      public setMenuBarVisibility(_b: boolean) {}
      public setAutoHideMenuBar(_b: boolean) {}
    })();
  })();
  public static rpcConfig: RpcConfiguration;

  public static ipcMain = (() => {
    return new (class extends EventEmitter {
      public handle(channel: string, listener: (...args: any[]) => any) {
        this.addListener(channel, listener);
      }
      public removeHandler(channel: string) {
        this.removeAllListeners(channel);
      }
    })();
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
