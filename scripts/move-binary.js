/**
 * This script is used to rename the binary with the platform specific postfix.
 * When `tauri build` is ran, it looks for the binary name appended with the platform specific postfix.
 */

const execa = require("execa");
const fse = require("fs-extra");

let extension = "";
if (process.platform === "win32") {
  extension = ".exe";
}

async function main() {
  const rustInfo = (await execa("rustc", ["-vV"])).stdout;
  const targetTriple = /host: (\S+)/g.exec(rustInfo)[1];
  if (!targetTriple) {
    console.error("Failed to determine platform target triple");
  }
  await fse.rename(
    `src-tauri/binaries/app${extension}`,
    `src-tauri/binaries/app-${targetTriple}${extension}`
  );
  // TODO: should probably be copy...
  await fse.copy(`dist/assets`, `src-tauri/binaries/assets`, {
    overwrite: true,
  });
  await fse.copy(`dist/node_modules`, `src-tauri/binaries/node_modules`, {
    overwrite: true,
  });
}

main().catch((e) => {
  throw e;
});
