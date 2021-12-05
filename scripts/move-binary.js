/**
 * This script is used to rename the binary with the platform specific postfix.
 * When `tauri build` is ran, it looks for the binary name appended with the platform specific postfix.
 */

const execa = require("execa");
const fse = require("fs-extra");
const path = require("path");

const extension = process.platform === "win32" ? ".exe" : "";

async function main() {
  const rustInfo = (await execa("rustc", ["-vV"])).stdout;
  const targetTriple = /host: (\S+)/g.exec(rustInfo)[1];
  if (!targetTriple) {
    console.error("Failed to determine platform target triple");
  }
  await fse.copy(
    process.execPath,
    path.resolve(`src-tauri/binaries/node-${targetTriple}${extension}`),
    {
      errorOnExist: false,
      overwrite: false,
    }
  );
  // TODO: should probably be copy...
  await fse.copy(`dist`, `src-tauri/binaries/dist`, {
    overwrite: true,
  });
  await fse.copy(`.env`, `src-tauri/binaries/.env`, {
    overwrite: true,
  });
}

main().catch((e) => {
  throw e;
});
