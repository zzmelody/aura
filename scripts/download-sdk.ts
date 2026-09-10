/** Downloads official Android build archives in bounded parallel ranges, then verifies SHA-1 from Google's manifest. */
import { mkdir, readFile, stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const [name, sizeInput, checksum] = process.argv.slice(2);
if (
  !/^[a-zA-Z0-9._-]+\.zip$/.test(name ?? "") ||
  !/^[a-f0-9]{40}$/i.test(checksum ?? "")
)
  throw new Error("Expected official archive name, byte size, and SHA-1.");
const size = Number(sizeInput);
if (!Number.isSafeInteger(size) || size < 1) throw new Error("Invalid size");
const target = resolve(".tools", name);
const parts = target + ".parts";
await mkdir(parts, { recursive: true });
const count = Math.ceil(size / (16 * 1024 * 1024));
let index = 0;
await Promise.all(
  Array.from({ length: 12 }, async () => {
    for (;;) {
      const part = index++;
      if (part >= count) break;
      const start = part * 16 * 1024 * 1024;
      const end = Math.min(size - 1, start + 16 * 1024 * 1024 - 1);
      const path = resolve(parts, String(part));
      const existing = await stat(path).catch(() => null);
      if (existing?.size === end - start + 1) continue;
      await new Promise((resolve, reject) => {
        const download = spawn(
          "curl.exe",
          [
            "-sS",
            "-L",
            "--fail",
            "--retry",
            "2",
            "--connect-timeout",
            "15",
            "--max-time",
            "240",
            "--range",
            `${start}-${end}`,
            `https://dl.google.com/android/repository/${name}`,
            "-o",
            path,
          ],
          { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
        );
        let error = "";
        download.stderr.on("data", (data) => {
          error += data;
        });
        download.on("error", reject);
        download.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(error)),
        );
      });
      if ((await stat(path)).size !== end - start + 1)
        throw new Error("Server did not honor byte range");
      console.log(`${name}: part ${part + 1}/${count}`);
    }
  }),
);
const file = await open(target, "w");
const hash = createHash("sha1");
try {
  for (let i = 0; i < count; i++) {
    const data = await readFile(resolve(parts, String(i)));
    hash.update(data);
    await file.write(data);
  }
} finally {
  await file.close();
}
if (hash.digest("hex") !== checksum.toLowerCase())
  throw new Error("Archive checksum mismatch");
console.log(`Verified ${target}`);
