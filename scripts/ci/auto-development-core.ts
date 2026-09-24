export type DevelopmentRequest = {
  kind: "issue" | "document";
  title: string;
  source: string;
  body: string;
};

const requestPath = /^docs\/requests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/;
const forbiddenPath = /^(?:\.github\/|scripts\/ci\/|docs\/requests\/)/i;

export function isRequestDocument(path: string): boolean {
  return requestPath.test(path) && !path.split("/").includes("..");
}

export function assertAllowedChanges(paths: string[]): void {
  if (paths.length === 0)
    throw new Error("Codex did not change any tracked or new files.");
  if (paths.length > 100) throw new Error("Codex changed more than 100 files.");
  for (const path of paths) {
    const parts = path.split("/");
    if (
      !path ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      /[\x00-\x1f]/.test(path) ||
      path.includes("\\") ||
      parts.includes("..") ||
      parts.includes(".git") ||
      parts.includes(".aura") ||
      parts.some(
        (part) => part === "AGENTS.md" || /^\.env(?:\.|$)/.test(part),
      ) ||
      forbiddenPath.test(path)
    ) {
      throw new Error(`Codex changed a protected path: ${path}`);
    }
  }
}

export function issueRequest(
  event: unknown,
  expectedLogin: string,
): DevelopmentRequest {
  if (!event || typeof event !== "object" || !("issue" in event)) {
    throw new Error("Issue event is missing the issue.");
  }
  const issue = event.issue;
  if (!issue || typeof issue !== "object")
    throw new Error("Invalid issue payload.");
  const item = issue as Record<string, unknown>;
  const user = item.user as Record<string, unknown> | undefined;
  if (user?.login !== expectedLogin)
    throw new Error("Issue author is not the trusted repository owner.");
  if (!Number.isSafeInteger(item.number) || Number(item.number) < 1)
    throw new Error("Invalid issue number.");
  if (typeof item.title !== "string" || typeof item.body !== "string") {
    throw new Error("Issue needs a title and a non-empty Markdown body.");
  }
  const title = item.title.trim();
  const body = item.body.trim();
  if (!title || !body || title.length > 300 || body.length > 40_000) {
    throw new Error("Issue title or body is empty or too long.");
  }
  return {
    kind: "issue",
    title,
    source: `https://github.com/zzmelody/aura/issues/${item.number}`,
    body,
  };
}

export function documentRequest(
  files: { path: string; body: string }[],
  commit: string,
): DevelopmentRequest {
  if (files.length === 0 || files.length > 5)
    throw new Error("Expected one to five changed request documents.");
  let total = 0;
  for (const file of files) {
    if (!isRequestDocument(file.path))
      throw new Error(`Invalid request document: ${file.path}`);
    total += file.body.length;
    if (file.body.length > 80_000)
      throw new Error(`Request document is too large: ${file.path}`);
  }
  if (total > 160_000)
    throw new Error("Request documents are too large together.");
  return {
    kind: "document",
    title: files.map((file) => file.path).join(", "),
    source: `https://github.com/zzmelody/aura/commit/${commit}`,
    body: files.map((file) => `### ${file.path}\n\n${file.body}`).join("\n\n"),
  };
}
