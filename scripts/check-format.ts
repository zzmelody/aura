import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

export type FormatBaseline = Record<string, string>;

// Git checkouts may convert line endings; they do not change a legacy identity.
export function formatHash(source: string): string {
  return createHash("sha256")
    .update(source.replace(/\r\n?/g, "\n"))
    .digest("hex");
}

/** Unchanged legacy files are allowed; edited and new files must be formatted. */
export async function checkFormat(
  root: string,
  files: string[],
  baseline: FormatBaseline,
): Promise<{ violations: string[]; legacy: number }> {
  const violations: string[] = [];
  let legacy = 0;
  for (const file of files) {
    const filepath = resolve(root, file);
    const info = await prettier.getFileInfo(filepath, {
      ignorePath: resolve(root, ".prettierignore"),
    });
    if (info.ignored || !info.inferredParser) continue;
    let source: string;
    try {
      source = await readFile(filepath, "utf8");
    } catch (error) {
      // Deleted files can still be in Git's index before they are staged.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const options = await prettier.resolveConfig(filepath);
    // EditorConfig still requests LF; normalize checkout EOLs for this gate.
    if (
      await prettier.check(source.replace(/\r\n?/g, "\n"), {
        ...options,
        filepath,
      })
    )
      continue;
    if (baseline[file] === formatHash(source)) legacy += 1;
    else violations.push(file);
  }
  return { violations, legacy };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const baseline: FormatBaseline = JSON.parse(
    await readFile(resolve(root, "format-baseline.json"), "utf8"),
  );
  const result = await checkFormat(root, files, baseline);
  if (result.violations.length) {
    console.error(
      "Format these new or changed files with pnpm exec prettier --write:",
    );
    for (const file of result.violations) console.error(`  ${file}`);
    process.exitCode = 1;
  } else {
    console.log(`Formatting passed (${result.legacy} unchanged legacy files).`);
  }
}
