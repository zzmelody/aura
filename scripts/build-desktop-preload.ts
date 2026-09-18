import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Sandboxed Electron preloads execute CommonJS, not TypeScript or ESM. */
export async function buildDesktopPreload(
  output = resolve(root, "apps/desktop/dist-host/preload.cjs"),
): Promise<string> {
  const source = resolve(root, "apps/desktop/src/preload.ts");
  const result = ts.transpileModule(await readFile(source, "utf8"), {
    fileName: source,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      verbatimModuleSyntax: false,
    },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length)
    throw new Error(
      errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result.outputText, "utf8");
  return output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildDesktopPreload();
