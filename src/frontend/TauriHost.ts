// part of the TauriHost that is in the frontend runtime

import { ProcessDetector } from "@bentley/bentleyjs-core";
import {
  AsyncMethodsOf,
  IpcApp,
  NativeApp,
  NativeAppOpts,
  PromiseReturnType,
} from "@bentley/imodeljs-frontend";
import {
  IpcSocketFrontend,
  IpcListener,
  IpcWebSocketFrontend,
} from "@bentley/imodeljs-common";
import type { EventCallback } from "@tauri-apps/api/event";
import * as TauriApi from "@tauri-apps/api";
import { Tauri, TauriRpcManager } from "src/common/TauriHost";
import { EventEmitter } from "events";

type TauriListener = EventCallback<Tauri.IpcRendererEvent>;

// this emulate the window.itwinjs interface used in the electron preload-based ipc app
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

const TauriIpcFrontend = IpcWebSocketFrontend;
// eslint-disable-next-line @typescript-eslint/no-redeclare
type TauriIpcFrontend = IpcWebSocketFrontend;

class _TauriIpcFrontend implements IpcSocketFrontend {
  private static checkPrefix(channel: string) {
    if (!channel.startsWith("itwin."))
      throw new Error(`illegal channel name '${channel}'`);
  }

  // NOTE: this replaces the electron preload script
  private api = new (class implements ITwinTauriApi {
    private taggedEvents = new EventEmitter();
    private emitter = new EventEmitter();
    public constructor() {
      TauriApi.event.listen<any>("ipcRenderer_event_respond", (event) => {
        const p = event.payload;
        try {
          const json = JSON.parse(p.json);
          if (json?.type === "ipc") {
            this.emitter.emit(json.channel, ...json.args);
          } else {
            this.taggedEvents.emit(json.tag, json, event);
          }
        } catch {
          console.log("received event in unknown format", event);
        }
      });
    }
    public addListener(channel: string, listener: TauriListener) {
      _TauriIpcFrontend.checkPrefix(channel);
      this.emitter.addListener(channel, listener);
    }
    public removeListener(channel: string, listener: TauriListener) {
      _TauriIpcFrontend.checkPrefix(channel);
      this.emitter.removeListener(channel, listener);
    }
    public once(channel: string, listener: TauriListener) {
      _TauriIpcFrontend.checkPrefix(channel);
      this.emitter.once(channel, listener);
    }
    async rawInvoke(
      type: string,
      tag: string | undefined,
      channel: string,
      ...data: any[]
    ): Promise<any> {
      _TauriIpcFrontend.checkPrefix(channel);
      if (tag === undefined) tag = `${Math.random()}`; // temporary tag; ignoring mostly for now
      const resultPromise = new Promise((resolve) =>
        this.taggedEvents.once(tag!, (json, _event) => {
          resolve(json);
        })
      );
      await TauriApi.event.emit(
        "ipcRenderer_event",
        JSON.stringify({
          type,
          channel,
          tag,
          args: data,
          json: JSON.stringify(data),
        })
      );
      const result = await resultPromise;
      return result;
    }
    async invoke(channel: string, ...data: any[]): Promise<any> {
      return await this.rawInvoke(
        "ipcRenderer_event",
        undefined,
        channel,
        ...data
      ).then((json) => json.result);
    }
    // rpc
    send(channel: string, ...data: any[]) {
      void this.rawInvoke("rpc_send_response", data[0].id, channel, ...data);
    }
  })();

  private listenerConversions = new Map<IpcListener, TauriListener>();

  public addListener(channelName: string, listener: IpcListener) {
    if (!this.listenerConversions.has(listener))
      this.listenerConversions.set(listener, (tauriEvt) =>
        // FIXME: fix the emit chain and use a real event after
        listener({} as Event, tauriEvt)
      );
    const convertedListener = this.listenerConversions.get(listener)!;
    this.api.addListener(channelName, convertedListener);
    return () => this.removeListener(channelName, listener);
  }
  public removeListener(channelName: string, listener: IpcListener) {
    if (!this.listenerConversions.has(listener)) return;
    const convertedListener = this.listenerConversions.get(listener)!;
    this.api.removeListener(channelName, convertedListener);
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
      throw new Error("Not running under Tauri");
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
