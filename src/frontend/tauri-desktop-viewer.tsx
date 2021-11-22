import {
  getInitializationOptions,
  isEqual,
  ItwinViewerInitializerParams,
  useBaseViewerInitializer,
  getIModelAppOptions,
  makeCancellable,
  BaseViewer,
} from "@itwin/viewer-react";
import { DesktopViewerProps } from "@itwin/desktop-viewer-react";
import React, { useEffect, useMemo, useState } from "react";
import { TauriApp, TauriAppOpts } from "src/common/TauriHost";
import { IModelApp } from "@bentley/imodeljs-frontend";

export class TauriDesktopInitializer {
  private static _initialized: Promise<void>;
  private static _initializing = false;
  private static _cancel: (() => void) | undefined;

  /** expose initialized promise */
  public static get initialized(): Promise<void> {
    return this._initialized;
  }

  /** expose initialized cancel method */
  public static cancel: () => void = () => {
    if (TauriDesktopInitializer._initializing) {
      if (TauriDesktopInitializer._cancel) {
        TauriDesktopInitializer._cancel();
      }
      TauriApp.shutdown().catch(() => {
        // Do nothing, its possible that we never started.
      });
    }
  };

  /** Desktop viewer startup */
  public static async startDesktopViewer(options?: DesktopViewerProps) {
    if (!IModelApp.initialized && !this._initializing) {
      console.log("starting desktop viewer");
      this._initializing = true;

      const cancellable = makeCancellable(function* () {
        const electronViewerOpts: TauriAppOpts = {
          iModelApp: getIModelAppOptions(options),
        };
        yield TauriApp.startup(electronViewerOpts);

        console.log("desktop viewer started");
      });

      TauriDesktopInitializer._cancel = cancellable.cancel;
      this._initialized = cancellable.promise
        .catch((err) => {
          if (err.reason !== "cancelled") {
            throw err;
          }
        })
        .finally(() => {
          TauriDesktopInitializer._initializing = false;
          TauriDesktopInitializer._cancel = undefined;
        });
    } else {
      this._initialized = Promise.resolve();
    }
  }
}
export const useTauriDesktopViewerInitializer = (
  options?: DesktopViewerProps
) => {
  const [desktopViewerInitOptions, setDesktopViewerInitOptions] =
    useState<ItwinViewerInitializerParams>();
  const [desktopViewerInitalized, setDesktopViewerInitalized] = useState(false);
  const baseViewerInitialized = useBaseViewerInitializer(
    options,
    !desktopViewerInitalized
  );

  // only re-initialize when initialize options change
  const initializationOptions = useMemo(
    () => getInitializationOptions(options),
    [options]
  );

  useEffect(() => {
    if (
      !desktopViewerInitOptions ||
      !isEqual(initializationOptions, desktopViewerInitOptions)
    ) {
      setDesktopViewerInitalized(false);
      setDesktopViewerInitOptions(initializationOptions);
      void TauriDesktopInitializer.startDesktopViewer(options).then(() => {
        void TauriDesktopInitializer.initialized.then(() => {
          setDesktopViewerInitalized(true);
        });
      });
    }
  }, [initializationOptions, desktopViewerInitOptions]);

  return baseViewerInitialized && desktopViewerInitalized;
};

export const Viewer = (props: DesktopViewerProps) => {
  const memoizedProps = useMemo(() => {
    return { ...props };
  }, [props]);

  const initialized = useTauriDesktopViewerInitializer(memoizedProps);

  return initialized ? <BaseViewer {...memoizedProps} /> : null; //TODO loader?
};
