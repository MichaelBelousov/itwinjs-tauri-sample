const path = require("path");

/** @type {import("webpack").Configuration} */
module.exports = {
  entry: "./lib/backend/main.js",
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "dist"),
  },
  target: "node",
};
