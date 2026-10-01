// Distribution entry for launchers that cannot pass environment variables
// (e.g. Godot's OS.execute_with_pipe). Usage: node launch.mjs --root=<dir>
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = process.argv.find((arg) => arg.startsWith("--root="))?.slice(7);
if (!root) {
  console.error("launch.mjs requires --root=<directory>");
  process.exit(2);
}
process.env.AURA_ROOT = root;
process.env.HOST = "127.0.0.1";
process.env.PORT ??= "0";

// Node refuses to strip types under node_modules; child processes spawned by
// the runtime (DSH orchestration) inherit this loader through NODE_OPTIONS.
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx/esm")).href;
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(loader)}`.trim();

const { register } = await import("tsx/esm/api");
register();
await import(new URL("./server.ts", import.meta.url).href);
