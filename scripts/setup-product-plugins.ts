import { mkdir, realpath, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Explicit development linking; never imported by application startup. */
for (const id of ["self-media", "site-launcher"]) {
  for (const [name, directory] of [
    ["hono", "packages/backend/orchestration/node_modules/hono"],
    ["zod", "packages/backend/orchestration/node_modules/zod"],
    ["fflate", "node_modules/fflate"],
    ["@aura/plugin-sdk", "packages/backend/plugin-sdk"],
    ["@aura/plugin-ui", "packages/frontend/plugin-ui"],
    ["@aura/workbench", "packages/frontend/workbench"],
    ["@aura/protocol", "packages/shared/protocol"],
    ["react", "apps/desktop/node_modules/react"],
    ["react-dom", "apps/desktop/node_modules/react-dom"],
    ["lucide-react", "apps/desktop/node_modules/lucide-react"],
    ["@types/react", "apps/desktop/node_modules/@types/react"],
    ["@types/react-dom", "apps/desktop/node_modules/@types/react-dom"],
  ]) {
    const target = await realpath(resolve(root, directory));
    const link = resolve(root, "plugins", id, "node_modules", name);
    const existing = await realpath(link).catch(() => undefined);
    if (existing === target) continue;
    if (existing)
      throw new Error(`Plugin dependency already points elsewhere: ${name}`);
    await mkdir(dirname(link), { recursive: true });
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
