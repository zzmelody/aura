import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serve, type ServerType } from "@hono/node-server";

/** Keep the renderer origin stable so Chromium can restore this app's local state. */
export async function startRendererServer(
  fetch: Parameters<typeof serve>[0]["fetch"],
  portFile: string,
): Promise<{ server: ServerType; url: string }> {
  let preferred = 0;
  try {
    const saved = await readFile(portFile, "utf8");
    const value = Number(saved);
    if (/^\d{1,5}$/u.test(saved) && value >= 1024 && value <= 65535)
      preferred = value;
  } catch {
    // This cache is optional; a first launch asks the OS for an available port.
  }
  const listen = (port: number) =>
    new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const server = serve({ fetch, hostname: "127.0.0.1", port }, (info) =>
        resolve({ server, port: info.port }),
      );
      server.once("error", reject);
    });
  const running = await listen(preferred).catch((error: unknown) => {
    if (preferred && (error as NodeJS.ErrnoException).code === "EADDRINUSE")
      return listen(0);
    throw error;
  });
  try {
    await mkdir(dirname(portFile), { recursive: true });
    await writeFile(portFile, String(running.port), { mode: 0o600 });
  } catch {
    // A read-only app cache must not prevent opening the workbench.
  }
  return { server: running.server, url: `http://127.0.0.1:${running.port}` };
}
