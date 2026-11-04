import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const ICON_PATH = resolve(
  import.meta.dirname,
  "../apps/desktop/assets/aura.ico",
);
const EXECUTABLE_NAME = "Aura.exe";
// Bump when the resource edits change to rebuild the cached executable.
const BRANDING_REVISION = 1;

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function prepareWindowsDesktopExecutable(
  stock: string,
  cacheDirectory: string,
): Promise<string> {
  const [icon, stockInfo] = await Promise.all([
    readFile(ICON_PATH),
    stat(stock),
  ]);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        BRANDING_REVISION,
        stock,
        stockInfo.size,
        stockInfo.mtimeMs,
      ]),
    )
    .update(icon)
    .digest("hex")
    .slice(0, 16);
  await mkdir(cacheDirectory, { recursive: true });
  const cache = await realpath(cacheDirectory);
  const prefix = `Aura-${key}-`;
  const stamp = resolve(cache, `Aura-${key}.stamp`);
  const cachedDirectory = (
    await readFile(stamp, "utf8").catch(() => "")
  ).trim();
  if (
    cachedDirectory.startsWith(prefix) &&
    basename(cachedDirectory) === cachedDirectory
  ) {
    const executable = resolve(cache, cachedDirectory, EXECUTABLE_NAME);
    if (await exists(executable)) return executable;
  }

  const runtime = await mkdtemp(resolve(cache, prefix));
  if (dirname(runtime) !== cache)
    throw new Error("Invalid Aura desktop cache path.");
  const executable = resolve(runtime, EXECUTABLE_NAME);
  try {
    const source = dirname(stock);
    const debugLog = resolve(source, "debug.log");
    await cp(source, runtime, {
      recursive: true,
      filter: (path) => path !== stock && path !== debugLog,
    });
    const copiedWer = resolve(runtime, "electron_wer.dll");
    if (await exists(copiedWer))
      await rename(copiedWer, resolve(runtime, "Aura_wer.dll"));
    await writeFile(executable, await brandExecutable(stock, icon));

    // Publish only after the whole runtime is ready. A directory watcher can
    // prevent moving the runtime directory itself on Windows.
    const pendingStamp = resolve(runtime, "ready.stamp");
    await writeFile(pendingStamp, `${basename(runtime)}\n`);
    await rename(pendingStamp, stamp);
    return executable;
  } catch (error) {
    await rm(runtime, { recursive: true, force: true, maxRetries: 4 });
    throw error;
  }
}

async function brandExecutable(stock: string, icon: Buffer): Promise<Buffer> {
  const { Data, NtExecutable, NtExecutableResource, Resource } =
    await import("resedit");
  const exe = NtExecutable.from(await readFile(stock), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (!groups.length || !versions.length)
    throw new Error(
      "Electron executable is missing Windows branding resources.",
    );

  const icons = Data.IconFile.from(icon).icons.map(({ data }) => data);
  for (const { id, lang } of groups)
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      id,
      lang,
      icons,
    );
  for (const version of versions) {
    for (const language of version.getAllLanguagesForStringValues())
      version.setStringValues(language, {
        FileDescription: "Aura",
        ProductName: "Aura",
        InternalName: EXECUTABLE_NAME,
        OriginalFilename: EXECUTABLE_NAME,
      });
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  return Buffer.from(exe.generate());
}
