/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { Logger, LogLevel } from "@bentley/bentleyjs-core";
import { IpcHost } from "@bentley/imodeljs-backend";
import { Presentation } from "@bentley/presentation-backend";
import { Menu } from "electron";
import { MenuItemConstructorOptions } from "electron/main";
import * as path from "path";
import * as fs from "fs";

import { AppLoggerCategory } from "../common/LoggerCategory";
import { channelName, viewerRpcs } from "../common/ViewerConfig";
import { appInfo, getAppEnvVar } from "./AppInfo";
import { TauriHost, TauriHostOptions } from "./TauriHost";
import ViewerHandler from "./ViewerHandler";

require("dotenv-flow").config(); // eslint-disable-line @typescript-eslint/no-var-requires

/** This is the function that gets called when we start iTwinViewer via `electron ViewerMain.js` from the command line.
 * It runs in the Electron main process and hosts the iModeljs backend (IModelHost) code. It starts the render (frontend) process
 * that starts from the file "index.ts". That launches the viewer frontend (IModelApp).
 */
const viewerMain = async () => {
  // Setup logging immediately to pick up any logging during IModelHost.startup()
  const latestLogFileNum =
    (await fs.promises.readdir(process.cwd()))
      .map((fileName) => /itwin-sidecar_(?<num>\d+)\.log/.exec(fileName))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => parseInt(match.groups!.num))
      // get the last number
      .sort((a, b) => b - a)[0] ?? 0;
  const logFile = await fs.promises.open(
    `itwin-sidecar_${latestLogFileNum + 1}.log`,
    "wx"
  );
  Logger.initialize(
    (category, message, getMetaData) =>
      logFile.write(
        `Error   |${category}| ${message}${(Logger as any).formatMetaData(
          getMetaData
        )}`
      ),
    (category, message, getMetaData) =>
      logFile.write(
        `Warning |${category}| ${message}${(Logger as any).formatMetaData(
          getMetaData
        )}`
      ),
    (category, message, getMetaData) =>
      logFile.write(
        `Info    |${category}| ${message}${(Logger as any).formatMetaData(
          getMetaData
        )}`
      ),
    (category, message, getMetaData) =>
      logFile.write(
        `Trace   |${category}| ${message}${(Logger as any).formatMetaData(
          getMetaData
        )}`
      )
  );
  process.on("exit", () => logFile.close());
  Logger.setLevelDefault(LogLevel.Warning);
  Logger.setLevel(AppLoggerCategory.Backend, LogLevel.Info);

  const clientId = getAppEnvVar("CLIENT_ID") ?? "";
  const scope = getAppEnvVar("SCOPE") ?? "";
  const redirectUri = getAppEnvVar("REDIRECT_URI");
  const issuerUrl = getAppEnvVar("ISSUER_URL");

  const tauriHost: TauriHostOptions = {
    webResourcesPath: path.join(__dirname, "..", "..", "build"),
    rpcInterfaces: viewerRpcs,
    developmentServer: process.env.NODE_ENV === "development",
    ipcHandlers: [ViewerHandler],
    authConfig: {
      clientId,
      scope,
      redirectUri: redirectUri || undefined, // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing
      issuerUrl: issuerUrl || undefined, // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing
    },
    iconName: "itwin-viewer.ico",
  };

  await TauriHost.startup({ tauriHost });

  Presentation.initialize();

  await TauriHost.openMainWindow({
    width: 1280,
    height: 800,
    show: true,
    title: appInfo.title,
    autoHideMenuBar: false,
  });

  // add the menu
  //TauriHost.mainWindow?.on("ready-to-show", createMenu);
};

const createMenu = () => {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac
      ? [
          {
            label: "iTwin Viewer",
            role: "appMenu",
            submenu: [
              {
                label: "Preferences",
                click: () => {
                  IpcHost.send(channelName, "preferences");
                },
              },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open snapshot file",
          click: () => {
            IpcHost.send(channelName, "snapshot");
          },
        },
        {
          label: "View remote iModel",
          click: () => {
            IpcHost.send(channelName, "remote");
          },
        },
        { type: "separator" },
        { label: "Close", role: isMac ? "close" : "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Getting started",
          click: () => {
            IpcHost.send(channelName, "home");
          },
        },
      ],
    },
    ...(isMac
      ? [
          {
            label: "Window",
            submenu: [
              {
                label: "Minimize",
                role: "minimize",
              },
              {
                label: "Zoom",
                role: "zoom",
              },
            ],
          },
        ]
      : []),
  ] as MenuItemConstructorOptions[];

  const menu = Menu.buildFromTemplate(template);

  Menu.setApplicationMenu(menu);
  TauriHost.mainWindow.setMenuBarVisibility(true);
  // this is overridden in ElectronHost and set to true so it needs to be...re-overriden??
  TauriHost.mainWindow.setAutoHideMenuBar(false);
};

try {
  void viewerMain();
} catch (error) {
  Logger.logError(AppLoggerCategory.Backend, error);
  process.exitCode = 1;
}
