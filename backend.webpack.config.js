const path = require("path");
const {
  getWebpackConfig,
} = require("@bentley/backend-webpack-tools/config/getWebpackConfig");

const imjsWebpackCfg = getWebpackConfig(
  path.resolve(__dirname, "./src/backend/main.ts"), // entry
  path.resolve(__dirname, "./dist"),
  false
);

/** @returns {import("webpack").Configuration} */
function getBackendWebpackConfig() {
  return {
    ...imjsWebpackCfg,
    // have to override output which will be incorrect main.ts
    output: {
      ...imjsWebpackCfg.output,
      filename: "main.js",
    },
    watchOptions: {
      ignored: "**/node_modules",
    },
    mode: process.env.NODE_ENV || "development",
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: [
            {
              loader: "ts-loader",
              /** @type {import("ts-loader").Options} */
              options: {
                configFile: "tsconfig.backend.json",
                // not ideal, but I'm too lazy to figure out how to properly webpack@4 it
                allowTsInNodeModules: true,
              },
            },
          ],
          // not ideal, but I'm too lazy to figure out how to properly webpack@4 it
          // or switch to webpack@5 for just the backend to see if that works
          include: [
            path.resolve(__dirname, "./src"),
            path.resolve(__dirname, "node_modules/@tauri-apps/api"),
          ],
          //exclude: /node_modules/,
        },
      ],
    },
    target: "node",
  };
}

module.exports = getBackendWebpackConfig();
