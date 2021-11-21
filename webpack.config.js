const path = require("path");

/** @type {import("webpack").Configuration} */
module.exports = {
  mode: process.env.NODE_ENV,
  entry: "./src/backend/main.ts",
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "dist"),
  },
  target: "node",
  /*
  optimization: {
    minimize: process.env.NODE_ENV === "production",
  },
  */
};
