/**
 * This script is used to rename the binary with the platform specific postfix.
 * When `tauri build` is ran, it looks for the binary name appended with the platform specific postfix.
 * It then copies other necessary resource files
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
  // TODO: this may not copy to the correct place (I believe pwd is actually just src-tauri, probably the dotEnv call needs to reflect that)
  await fse.copy(`.env`, `src-tauri/.env`, {
    overwrite: true,
  });
}

main().catch((e) => {
  throw e;
});
