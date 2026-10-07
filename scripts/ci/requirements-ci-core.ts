import { createHash } from "node:crypto";

export type Requirement = {
  path: string;
  id: string;
  title: string;
  visual: boolean;
  status: "待处理" | "已完成";
  text: string;
  digest: string;
};

const requirementPath =
  /^docs\/requirements\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;
const statusLine = /^(status|状态):[ \t]*(待处理|已完成)[ \t]*$/m;

export function parseRequirement(path: string, text: string): Requirement {
  const match = requirementPath.exec(path);
  if (!match || path.includes(".."))
    throw new Error(`Invalid requirement path: ${path}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!frontmatter) throw new Error(`${path}: YAML frontmatter is required.`);
  const status = statusLine.exec(frontmatter[1]);
  if (!status) throw new Error(`${path}: status must be 待处理 or 已完成.`);
  const visualValue = /^visual:[ \t]*(true|false)[ \t]*$/m.exec(frontmatter[1]);
  const heading = /^#\s+(.+)$/m.exec(text.slice(frontmatter[0].length));
  if (!heading) throw new Error(`${path}: a title heading is required.`);
  if (!/^##\s+验收标准\s*$/m.test(text))
    throw new Error(`${path}: a 验收标准 section is required.`);
  if (text.length > 80_000)
    throw new Error(`${path}: requirement is too large.`);
  return {
    path,
    id: match[1],
    title: heading[1].trim(),
    visual: visualValue?.[1] === "true",
    status: status[2] as Requirement["status"],
    text,
    digest: requirementDigest(text),
  };
}

export function requirementDigest(text: string): string {
  return createHash("sha256")
    .update(text.replace(statusLine, "$1: <status>").replace(/\r\n/g, "\n"))
    .digest("hex");
}

export function completeRequirement(text: string): string {
  if (!statusLine.test(text))
    throw new Error("Requirement has no status field.");
  return text.replace(statusLine, "$1: 已完成");
}

export function assertGeneratedPaths(
  paths: string[],
  requirement: Requirement,
  completedText: string,
): void {
  if (paths.length === 0 || paths.length > 100)
    throw new Error("Expected 1–100 changed files.");
  if (requirementDigest(completedText) !== requirement.digest)
    throw new Error("Requirement body changed during development.");
  if (parseRequirement(requirement.path, completedText).status !== "已完成")
    throw new Error("Requirement was not marked complete.");
  for (const file of paths) {
    const parts = file.split("/");
    if (
      !file ||
      file.startsWith("/") ||
      /^[A-Za-z]:/.test(file) ||
      // eslint-disable-next-line no-control-regex -- Intentionally sanitize or detect ASCII control characters.
      /[\\\x00-\x1f]/.test(file) ||
      parts.includes("..") ||
      parts.includes(".git") ||
      parts.includes(".codex") ||
      parts.includes(".aura") ||
      parts.some(
        (part) => part === "AGENTS.md" || /^\.env(?:\.|$)/.test(part),
      ) ||
      file.startsWith(".github/") ||
      file === ".gitmodules" ||
      file.startsWith("scripts/ci/") ||
      file === "tools/requirements-ci.ts" ||
      file === "tools/requirements-ci-core.ts" ||
      file === "tools/Run-CodexWithGpuLock.ps1" ||
      file.startsWith("ci-evidence/") ||
      (file.startsWith("docs/requirements/") && file !== requirement.path)
    )
      throw new Error(`Generated change touches a protected path: ${file}`);
  }
}
