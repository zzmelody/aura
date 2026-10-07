import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Emits the plain ESM bootstrap needed before Node can load TS in node_modules. */
export async function buildServerLauncher(
  output = resolve(repositoryRoot, "apps/server/dist/launch.js"),
): Promise<string> {
  const source = await readFile(
    resolve(repositoryRoot, "apps/server/src/launch.ts"),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, outputText);
  return output;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(await buildServerLauncher());
}
