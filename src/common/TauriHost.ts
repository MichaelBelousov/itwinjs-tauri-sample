// part of the TauriHost that is common to backend/frontend

import { BentleyStatus, ProcessDetector } from "@bentley/bentleyjs-core";
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
  RpcInterface,
} from "@bentley/imodeljs-common";
import { PresentationRpcInterface } from "@bentley/presentation-common";

import type { IpcRendererEvent as ElectronIpcRendererEvent } from "electron";

export namespace Tauri {
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
      // FIXME: could check process.argv to see if it's Tauri
      typeof process === "object"
    );
  },
});

Object.defineProperty(ProcessDetector, "isTauriAppFrontend", {
  get() {
    return typeof window !== "undefined" && "__TAURI__" in window;
  },
});
