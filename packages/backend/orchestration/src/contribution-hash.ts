import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "acorn";

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
};

/** Hash owned files plus the static local ESM dependency closure of a trusted plugin.
 * Bare package imports remain governed by the installed dependency/SDK contract.
 */
export async function hashContribution(
  directory: string,
  pluginRoot?: string,
): Promise<string> {
  const owner = await realpath(directory);
  const root = pluginRoot ? await realpath(pluginRoot) : owner;
  if (!inside(root, owner))
    throw new Error("Contribution is outside its trusted plugin root.");
  const files = new Map<string, Buffer>();
  async function file(path: string) {
    const resolved = await realpath(path);
    if (!inside(root, resolved))
      throw new Error("Local module escapes its trusted plugin root.");
    const name = relative(root, resolved).replaceAll("\\", "/");
    if (files.has(name)) return;
    const bytes = await readFile(resolved);
    files.set(name, bytes);
    if (!pluginRoot || !/\.[cm]?js$/u.test(resolved)) return;
    const ast = parse(bytes.toString("utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    const dependencies = new Set<string>();
    function walk(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
        ].includes(node.type as string)
      ) {
        const source = node.source as
          { type?: string; value?: unknown } | undefined;
        if (source) {
          if (source.type !== "Literal" || typeof source.value !== "string")
            throw new Error(
              "Plugin dependencies must use literal module specifiers.",
            );
          dependencies.add(source.value);
        }
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(walk);
        else if (child && typeof child === "object") walk(child);
      }
    }
    walk(ast);
    for (const dependency of dependencies) {
      if (dependency.startsWith("file:") || isAbsolute(dependency))
        throw new Error(
          "Plugin local dependencies must use relative module specifiers.",
        );
      if (dependency.startsWith(".")) {
        if (/[?#]/u.test(dependency))
          throw new Error(
            "Plugin module specifiers cannot contain queries or fragments.",
          );
        await file(resolve(dirname(resolved), dependency));
      }
    }
  }
  async function tree(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink())
        throw new Error("Contribution files cannot be symbolic links.");
      if (entry.isDirectory()) await tree(join(path, entry.name));
      if (entry.isFile()) await file(join(path, entry.name));
    }
  }
  await tree(owner);
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    hash.update(name).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}
