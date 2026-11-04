import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareWindowsDesktopExecutable } from "./desktop-windows.ts";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(root, "apps/desktop");
const PRODUCT_NAME = "Aura";
const BUNDLE_ID = "dev.aura.desktop";
/** Bump when the patch below changes, so existing copies are rebuilt. */
const BUNDLE_REVISION = 1;

/**
 * Selects the Electron binary for development and static preview. Windows
 * uses a branded executable and macOS reads the Dock name from the bundle.
 */
export async function desktopExecutable(): Promise<string> {
  const require = createRequire(resolve(appRoot, "package.json"));
  const stock = require("electron") as unknown;
  if (typeof stock !== "string")
    throw new Error("Electron binary path is unavailable.");
  if (process.platform === "win32")
    return prepareWindowsDesktopExecutable(
      resolve(stock),
      // Keep the copy out of the workspace: new files inherit its ACL, and a
      // Low integrity label there (set by sandboxed tooling) makes the copied
      // Electron crash with EXCEPTION_BREAKPOINT at startup.
      resolve(process.env.LOCALAPPDATA ?? tmpdir(), "Aura", "desktop-runtime"),
    );
  if (process.platform !== "darwin") return stock;

  const source = resolve(stock, "../../..");
  const target = resolve(appRoot, "dist-host", `${PRODUCT_NAME}.app`);
  const stamp = resolve(appRoot, "dist-host", `${PRODUCT_NAME}.app.stamp`);
  const version = (
    await readFile(resolve(source, "../version"), "utf8")
  ).trim();
  const expected = `${version}:${BUNDLE_REVISION}`;
  const executable = resolve(target, "Contents/MacOS/Electron");
  try {
    if ((await readFile(stamp, "utf8")).trim() === expected) return executable;
  } catch {
    // No stamp yet: build the bundle below.
  }

  // Build beside the target and swap in, so an interrupted run never leaves a
  // half-patched bundle that a later launch would trust.
  const staging = `${target}.partial`;
  await rm(staging, { recursive: true, force: true });
  // APFS clones make the ~300 MB copy nearly free; other filesystems copy.
  await cp(source, staging, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const plist = resolve(staging, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleName", PRODUCT_NAME],
    ["CFBundleDisplayName", PRODUCT_NAME],
    ["CFBundleIdentifier", BUNDLE_ID],
  ])
    await run("plutil", ["-replace", key, "-string", value, plist]);
  // Editing Info.plist breaks the stock ad-hoc seal; re-sign locally.
  await run("codesign", ["--force", "--deep", "--sign", "-", staging]);
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  await writeFile(stamp, `${expected}\n`);
  return executable;
}

// `tsx scripts/desktop-bundle.ts <args>` launches the desktop app directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executable = await desktopExecutable();
  // An inherited ELECTRON_RUN_AS_NODE would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  const child = spawn(executable, process.argv.slice(2), {
    cwd: appRoot,
    stdio: "inherit",
    env,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.once("exit", (code) => process.exit(code ?? 0));
}
