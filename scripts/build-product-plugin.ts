import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import ts from "typescript";

const id = process.argv[2];
if (id !== "self-media" && id !== "site-launcher")
  throw new Error("Unknown product plugin.");
const workspace = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(workspace, "plugins", id);
if (id === "site-launcher") {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      ssr: true,
      target: "node24",
      minify: false,
      outDir: resolve(root, "backend/dist"),
      lib: {
        entry: resolve(root, "backend/site-runner.ts"),
        formats: ["es"],
        fileName: () => "site-runner.js",
      },
    },
  });
  // The checked TS runner is bundled for execution; emit its authoring types too.
  const base = ts.readConfigFile(
    resolve(workspace, "tsconfig.base.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, workspace);
  const backend = resolve(root, "backend");
  const program = ts.createProgram([resolve(backend, "site-runner.ts")], {
    ...parsed.options,
    noEmit: false,
    allowJs: false,
    checkJs: false,
    declaration: true,
    emitDeclarationOnly: true,
    types: ["node"],
  });
  const outputs = new Map<string, string>();
  program.emit(undefined, (path, source) => {
    if (
      [
        "site-runner.d.ts",
        "site-project.d.ts",
        "site-network.d.ts",
        "site-process.d.ts",
      ].includes(basename(path))
    ) {
      outputs.set(resolve(backend, "dist", basename(path)), source);
    }
  });
  if (outputs.size !== 4)
    throw new Error("Runner declaration build was incomplete.");
  for (const [path, source] of outputs) await writeFile(path, source);
}
if (id === "self-media") {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: "node24",
      minify: false,
      outDir: resolve(root, "backend/dist"),
      rollupOptions: {
        input: {
          service: resolve(root, "backend/service.ts"),
          production: resolve(root, "backend/production.ts"),
          http: resolve(root, "backend/http.ts"),
        },
        external: (id) =>
          id.startsWith("node:") ||
          id.startsWith("@aura/plugin-sdk/") ||
          id.startsWith("@aura/protocol/") ||
          id === "hono" ||
          id.startsWith("hono/") ||
          id === "zod",
        output: {
          banner: "// @ts-check",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  });
  const base = ts.readConfigFile(
    resolve(workspace, "tsconfig.base.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, workspace);
  const program = ts.createProgram([resolve(root, "backend/service.ts")], {
    ...parsed.options,
    noEmit: false,
    allowJs: false,
    checkJs: false,
    declaration: true,
    emitDeclarationOnly: true,
    types: ["node"],
  });
  program.emit(undefined, (path, source) => {
    if (basename(path) === "service.d.ts")
      ts.sys.writeFile(resolve(root, "backend/dist/service.d.ts"), source);
  });
  // Contributions are a complete generated tree; removed sources must not remain discoverable.
  for (const kind of ["flows", "actions"]) {
    const target = resolve(root, kind);
    if (dirname(target) !== root)
      throw new Error("Invalid generated contribution root.");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
  }
  for (const [kind, singular] of [
    ["flows", "flow"],
    ["actions", "action"],
  ] as const) {
    for (const local of (
      await readdir(resolve(root, "backend/contributions", kind), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const directory = resolve(root, "backend/contributions", kind, local);
      const sourceName = (await readdir(directory)).find(
        (name) =>
          name.endsWith(`.${singular}.ts`) || name.endsWith(`.${singular}.js`),
      );
      if (!sourceName) throw new Error("Missing contribution source.");
      let source = await readFile(resolve(directory, sourceName), "utf8");
      source = source.replace(
        /"\.\.\/\.\.\/\.\.\/[^"]+\.ts"/gu,
        '"../../backend/dist/production.js"',
      );
      source = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText;
      const target = resolve(root, kind, local, `${local}.${singular}.js`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        "// @ts-check\n" + source.replace(/^\/\/ @ts-check\r?\n/u, ""),
      );
    }
  }
}
const manifest = JSON.parse(
  await readFile(resolve(root, "aura.plugin.json"), "utf8"),
) as { contributes: { pages: string } };
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
        const target = resolve(root, manifest.contributes.pages);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await mkdir(dirname(target), { recursive: true });
        try {
          await writeFile(
            temporary,
            `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${entry.code}\nreturn module.exports;\n}});\n`,
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
