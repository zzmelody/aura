import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { modelViewerAssets } from "./model-viewer-assets.ts";

const target = process.argv[2];
if (target !== "web" && target !== "desktop" && target !== "mobile")
  throw new Error("Usage: build-renderer.ts <web|desktop|mobile>");
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps",
  target,
);
await build({
  root,
  configFile: resolve(root, "vite.config.ts"),
  plugins: [modelViewerAssets()],
});
