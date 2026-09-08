/** Read-only dependency checks for Aura's pnpm workspaces. */
import { access, readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const layers = ["frontend", "backend", "shared"];
const expectedWorkspaces = layers.map((layer) => `packages/${layer}/*`);
const allowedLayers = {
  frontend: new Set(["frontend", "shared"]),
  backend: new Set(["backend", "shared"]),
  shared: new Set(["shared"]),
};
const ignored = new Set([
  "node_modules",
  "dist",
  "android",
  "ios",
  ".expo",
  ".git",
]);
const extensions = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);
const directModelClients = new Set([
  "@earendil-works/pi-ai",
  "@mariozechner/pi-ai",
]);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const inside = (root, path) => path === root || path.startsWith(root + sep);

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (extensions.has(extname(path))) files.push(path);
  }
  return files;
}

function imports(source, path) {
  const result = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const add = (value) => {
    if (value && ts.isStringLiteralLike(value)) result.push(value.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const match of source.matchAll(/import\(['"](@aura\/[^'"]+)['"]\)/g))
    result.push(match[1]);
  return result;
}

/**
 * Checks package metadata, layer dependencies, public imports and cycles.
 * @param {string} root Absolute repository directory.
 * @returns {Promise<string[]>} Violations; an empty list means all checks passed.
 */
export async function checkWorkspaces(root) {
  const errors = [];
  const rootManifest = await readJson(resolve(root, "package.json"));
  if (JSON.stringify(rootManifest.workspaces) !== JSON.stringify(expectedWorkspaces))
    errors.push(`Root workspaces must be ${expectedWorkspaces.join(", ")}.`);

  const packages = new Map();
  for (const layer of layers) {
    const layerDir = resolve(root, "packages", layer);
    for (const entry of await readdir(layerDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const label = `packages/${layer}/${entry.name}`;
      const dir = resolve(layerDir, entry.name);
      let manifest;
      try {
        manifest = await readJson(resolve(dir, "package.json"));
      } catch (error) {
        errors.push(`${label}: unreadable package.json (${error.message}).`);
        continue;
      }
      if (!manifest.name?.startsWith("@aura/") || manifest.private !== true)
        errors.push(`${label}: requires a private @aura/* package.`);
      if (manifest.aura?.layer !== layer)
        errors.push(`${label}: aura.layer must be ${layer}.`);
      if (!new Set(["app", "library"]).has(manifest.aura?.kind))
        errors.push(`${label}: aura.kind must be app or library.`);
      if (packages.has(manifest.name)) errors.push(`Duplicate package ${manifest.name}.`);
      packages.set(manifest.name, { dir, layer, manifest });
    }
  }

  for (const [name, owner] of packages) {
    const { dir, layer, manifest } = owner;
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    if (manifest.aura?.kind === "library" && !manifest.exports)
      errors.push(`${name}: library is missing public exports.`);
    for (const dep of Object.keys(declared))
      if (directModelClients.has(dep))
        errors.push(
          `${name}: model providers must use DSH; direct dependency ${dep} is forbidden.`,
        );
    for (const target of Object.values(manifest.exports ?? {})) {
      if (
        typeof target !== "string" ||
        !target.startsWith("./") ||
        !inside(dir, resolve(dir, target))
      ) {
        errors.push(`${name}: export target must be an explicit in-package file.`);
        continue;
      }
      try {
        await access(resolve(dir, target));
      } catch {
        errors.push(`${name}: missing export file ${target}.`);
      }
    }
    for (const [dep, version] of Object.entries(declared)) {
      if (!dep.startsWith("@aura/")) continue;
      const target = packages.get(dep);
      if (!target) {
        errors.push(`${name}: unknown workspace ${dep}.`);
        continue;
      }
      if (target.manifest.aura?.kind === "app")
        errors.push(`${name}: cannot depend on application ${dep}.`);
      if (!allowedLayers[layer].has(target.layer))
        errors.push(`${name}: ${layer} packages cannot depend on ${target.layer} package ${dep}.`);
      if (version !== "workspace:*") errors.push(`${name}: ${dep} must use workspace:*.`);
    }
    for (const path of await sourceFiles(dir)) {
      for (const specifier of imports(await readFile(path, "utf8"), path)) {
        const label = relative(root, path);
        if (specifier.startsWith(".")) {
          if (!inside(dir, resolve(path, "..", specifier)))
            errors.push(`${label}: cross-package relative import ${specifier}.`);
          continue;
        }
        if (isBuiltin(specifier)) continue;
        const dep = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (dep !== name && !Object.hasOwn(declared, dep))
          errors.push(`${label}: undeclared dependency ${dep}.`);
        if (!dep.startsWith("@aura/")) continue;
        const target = packages.get(dep);
        const subpath = specifier === dep ? "." : "." + specifier.slice(dep.length);
        if (target && !Object.hasOwn(target.manifest.exports ?? {}, subpath))
          errors.push(`${label}: ${specifier} is not a public export.`);
      }
    }
  }

  const visited = new Set();
  const active = new Set();
  function visit(name) {
    if (active.has(name)) {
      errors.push(`Workspace dependency cycle through ${name}.`);
      return;
    }
    if (visited.has(name)) return;
    active.add(name);
    const manifest = packages.get(name).manifest;
    for (const dep of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }))
      if (packages.has(dep)) visit(dep);
    active.delete(name);
    visited.add(name);
  }
  for (const name of packages.keys()) visit(name);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkWorkspaces(fileURLToPath(new URL("../", import.meta.url)));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Workspace metadata, layers, exports, imports and dependency graph passed.");
  }
}
