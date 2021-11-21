const path = require("path");
const {
  getWebpackConfig,
} = require("@bentley/backend-webpack-tools/config/getWebpackConfig");

/** @returns {import("webpack").Configuration} */
function getBackendWebpackConfig() {
  return {
    ...getWebpackConfig(
      path.resolve(__dirname, "./src/backend/main.ts"), // entry
      path.resolve(__dirname, "./dist"),
      false
    ),
    watchOptions: {
      ignored: "**/node_modules",
    },
    mode: process.env.NODE_ENV,
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
              },
            },
          ],
          exclude: /node_modules/,
        },
      ],
    },
  };
}

module.exports = getBackendWebpackConfig();
