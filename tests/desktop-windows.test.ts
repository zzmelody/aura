import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { prepareWindowsDesktopExecutable } from "../scripts/desktop-windows.ts";

test(
  "Windows desktop launches with the Aura executable name, description and icon",
  { skip: process.platform !== "win32" && "Requires Windows Electron" },
  async (t) => {
    const appRoot = resolve(import.meta.dirname, "../apps/desktop");
    const require = createRequire(resolve(appRoot, "package.json"));
    const stock: unknown = require("electron");
    assert.ok(typeof stock === "string", "Missing Electron binary.");
    const tempRoot = await realpath(tmpdir());
    const cache = await mkdtemp(resolve(tempRoot, "aura-desktop-"));
    if (dirname(cache) !== tempRoot)
      throw new Error("Invalid test cache path.");
    t.after(() => rm(cache, { recursive: true, force: true }));

    const stockInfo = await stat(stock);
    const executable = await prepareWindowsDesktopExecutable(stock, cache);
    assert.equal(basename(executable), "Aura.exe");
    assert.equal((await stat(stock)).mtimeMs, stockInfo.mtimeMs);
    assert.equal(
      await prepareWindowsDesktopExecutable(stock, cache),
      executable,
    );

    const resources = NtExecutableResource.from(
      NtExecutable.from(await readFile(executable)),
    );
    const versions = Resource.VersionInfo.fromEntries(resources.entries);
    assert.ok(versions.length);
    for (const version of versions) {
      const languages = version.getAllLanguagesForStringValues();
      assert.ok(languages.length);
      for (const language of languages) {
        const fields = version.getStringValues(language);
        assert.equal(fields.FileDescription, "Aura");
        assert.equal(fields.ProductName, "Aura");
        assert.equal(fields.OriginalFilename, "Aura.exe");
      }
    }
    const icon = Data.IconFile.from(
      await readFile(resolve(appRoot, "assets/aura.ico")),
    );
    const iconBytes = (item: Data.IconItem | Data.RawIconItem) =>
      Buffer.from(item.isRaw() ? item.bin : item.generate());
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
    assert.ok(groups.length);
    for (const group of groups)
      assert.deepEqual(
        group.getIconItemsFromEntries(resources.entries).map(iconBytes),
        icon.icons.map(({ data }) => iconBytes(data)),
      );

    const { stdout } = await promisify(execFile)(executable, ["--version"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 10_000,
    });
    assert.match(stdout.trim(), /^v\d+\.\d+\.\d+$/);

    await writeFile(
      resolve(cache, "package.json"),
      JSON.stringify({ name: "aura-probe", type: "module", main: "probe.ts" }),
    );
    await writeFile(
      resolve(cache, "probe.ts"),
      `import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const profile = resolve(import.meta.dirname, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("data:text/html,Aura");
  writeFileSync(resolve(import.meta.dirname, "probe.json"), JSON.stringify({
    defaultApp: process.defaultApp,
    dev: process.argv.includes("--dev"),
    hasIcon: !(await app.getFileIcon(process.execPath)).isEmpty(),
  }));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
`,
    );
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
    await promisify(execFile)(executable, [".", "--dev"], {
      cwd: cache,
      env,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.deepEqual(
      JSON.parse(await readFile(resolve(cache, "probe.json"), "utf8")),
      { defaultApp: true, dev: true, hasIcon: true },
    );
  },
);
