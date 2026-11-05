import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const id = process.argv[2];
if (id !== "site-launcher" && id !== "tripo")
  throw new Error("Unknown product plugin.");
const workspace = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(workspace, "plugins", id);
const manifest = JSON.parse(
  await readFile(resolve(root, "aura.plugin.json"), "utf8"),
) as {
  id: string;
  contributes: { backend: string; pages?: string; http?: { entry: string } };
};

// The backend entry is bundled to the single ESM module the manifest names.
// The SDK stays external: the Aura host provides it at load time.
const backendEntry = resolve(root, manifest.contributes.backend);
await rm(dirname(backendEntry), { recursive: true, force: true });
const entries = {
  index: resolve(root, "backend/index.ts"),
  ...(manifest.contributes.http
    ? { http: resolve(root, "backend/http.ts") }
    : {}),
};
await build({
  configFile: false,
  root,
  logLevel: "warn",
  ssr: { noExternal: ["hono", "@vastai/tripo-sdk"] },
  build: {
    ssr: true,
    target: "node24",
    minify: false,
    outDir: dirname(backendEntry),
    lib: {
      entry: entries,
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: (source) =>
        source.startsWith("node:") ||
        source === "@aura/plugin-sdk" ||
        source.startsWith("@aura/plugin-sdk/"),
    },
  },
});
const page = manifest.contributes.pages;
if (page)
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    plugins: [
      {
        name: "aura-product-plugin",
        async generateBundle(_options, bundle) {
          const chunks = Object.values(bundle);
          const entry = chunks.find(
            (chunk) => chunk.type === "chunk" && chunk.isEntry,
          );
          if (!entry || entry.type !== "chunk" || chunks.length !== 1)
            throw new Error("Expected one browser chunk.");
          const target = resolve(root, page);
          const temporary = `${target}.${randomUUID()}.tmp`;
          await mkdir(dirname(target), { recursive: true });
          try {
            await writeFile(
              temporary,
              `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.id)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${entry.code}\nreturn module.exports;\n}});\n`,
            );
            await rename(temporary, target);
          } finally {
            await rm(temporary, { force: true });
          }
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(root, "client/src/page.tsx"), formats: ["cjs"] },
      rollupOptions: {
        external: [
          "react",
          "react/jsx-runtime",
          "react-dom",
          "react-dom/client",
          "@deepseek-ai/cordis",
          "@aura/plugin-ui",
          "@aura/workbench/plugin",
          "@aura/workbench/transport",
        ],
        output: { exports: "named" },
      },
    },
  });
console.log(`Built product plugin: ${id}`);
