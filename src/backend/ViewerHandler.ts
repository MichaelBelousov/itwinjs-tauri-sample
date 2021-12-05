/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { IpcHandler } from "@bentley/imodeljs-backend";

import {
  channelName,
  ViewerConfig,
  ViewerFile,
  ViewerIpc,
  ViewerSettings,
} from "../common/ViewerConfig";
import { getAppEnvVar } from "./AppInfo";
import UserSettings from "./UserSettings";

class ViewerHandler extends IpcHandler implements ViewerIpc {
  public get channelName() {
    return channelName;
  }
  /**
   * create the config object to send to the frontend
   * @returns Promise<ViewerConfig>
   */
  public async getConfig(): Promise<ViewerConfig> {
    //const parsedArgs = minimist(process.argv.slice(2)); // first two arguments are .exe name and the path to ViewerMain.js. Skip them.
    return {
      snapshotName: getAppEnvVar("SNAPSHOT"),
      clientId: getAppEnvVar("CLIENT_ID") ?? "",
      redirectUri: getAppEnvVar("REDIRECT_URI") ?? "",
      issuerUrl: getAppEnvVar("ISSUER_URL"),
    };
  }

  /**
   * Get user settings
   * @returns ViewerSettings
   */
  public async getSettings(): Promise<ViewerSettings> {
    return UserSettings.settings;
  }

  /**
   * Add a recent file
   * @param file
   */
  public async addRecentFile(file: ViewerFile): Promise<void> {
    UserSettings.addRecent(file);
  }
}

export default ViewerHandler;
