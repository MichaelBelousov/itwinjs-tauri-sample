// part of the TauriHost that is in the frontend runtime

import { ProcessDetector } from "@bentley/bentleyjs-core";
import {
  AsyncMethodsOf,
  IpcApp,
  NativeApp,
  NativeAppOpts,
  PromiseReturnType,
} from "@bentley/imodeljs-frontend";
import { IpcSocketFrontend, IpcListener } from "@bentley/imodeljs-common";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import type { IpcRendererEvent as ElectronIpcRendererEvent } from "electron";
import * as TauriApi from "@tauri-apps/api";
import { TauriRpcManager } from "src/common/TauriHost";

namespace Tauri {
  export interface BrowserWindow
    extends Partial<import("electron").BrowserWindow> {}

  export interface BrowserWindowConstructorOptions
    extends Partial<import("electron").BrowserWindowConstructorOptions> {}

  export interface IpcRendererEvent extends ElectronIpcRendererEvent {}
}

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

class TauriIpcFrontend implements IpcSocketFrontend {
  private static checkPrefix(channel: string) {
    if (!channel.startsWith("itwin."))
      throw new Error(`illegal channel name '${channel}'`);
  }

  // NOTE: this replaces the electron preload script
  private api = new (class implements ITwinTauriApi {
    private _unlisteners = new Map<
      string,
      Map<TauriListener, Promise<UnlistenFn>>
    >();
    public addListener(channel: string, listener: TauriListener) {
      TauriIpcFrontend.checkPrefix(channel);
      if (!this._unlisteners.has(channel))
        this._unlisteners.set(channel, new Map());
      const unlistenerPromise = TauriApi.event.listen(channel, listener);
      this._unlisteners.get(channel)!.set(listener, unlistenerPromise);
    }
    public removeListener(channel: string, listener: TauriListener) {
      TauriIpcFrontend.checkPrefix(channel);
      this._unlisteners
        .get(channel)
        ?.get(listener)
        ?.then((unlistener) => unlistener());
    }
    public once(channel: string, listener: TauriListener) {
      TauriIpcFrontend.checkPrefix(channel);
      if (!this._unlisteners.has(channel))
        this._unlisteners.set(channel, new Map());
      const unlistenerPromise = TauriApi.event.once(channel, listener);
      this._unlisteners.get(channel)!.set(listener, unlistenerPromise);
    }
    async invoke(channel: string, ...data: any[]): Promise<any> {
      TauriIpcFrontend.checkPrefix(channel);
      return TauriApi.invoke("ipcRenderer_invoke", {
        type: "ipcRenderer_invoke",
        channel,
        args: data,
        json: JSON.stringify(data),
      });
    }
    send(channel: string, ...data: any[]) {
      TauriIpcFrontend.checkPrefix(channel);
      TauriApi.invoke("ipcRenderer_send", {
        type: "ipcRenderer_send",
        channel,
        args: data,
        json: JSON.stringify(data),
      });
    }
  })();

  private listenerConversions = new Map<IpcListener, TauriListener>();

  public addListener(channelName: string, listener: IpcListener) {
    if (!this.listenerConversions.has(listener))
      this.listenerConversions.set(listener, (tauriEvt) =>
        listener(new Event(tauriEvt.event, tauriEvt.payload))
      );
    const convertedListener = this.listenerConversions.get(listener)!;
    this.api.addListener(channelName, convertedListener);
    return () => this.removeListener(channelName, listener);
  }
  public removeListener(channelName: string, listener: IpcListener) {
    if (!this.listenerConversions.has(listener))
      this.listenerConversions.set(listener, (tauriEvt) =>
        listener(new Event(tauriEvt.event, tauriEvt.payload))
      );
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
