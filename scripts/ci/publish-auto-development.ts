import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAllowedChanges } from "./auto-development-core.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${program} ${args[0]} failed: ${result.stderr.slice(-2000)}`,
    );
  return result.stdout.trim();
}

if (env("GITHUB_REPOSITORY") !== "zzmelody/aura")
  throw new Error("Unexpected repository.");
const runId = env("GITHUB_RUN_ID");
const attempt = env("GITHUB_RUN_ATTEMPT");
if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt))
  throw new Error("Invalid workflow run identity.");
const slug = env("APP_SLUG");
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
  throw new Error("Invalid GitHub App slug.");
env("GH_TOKEN");

const artifact = path.join(env("RUNNER_TEMP"), "auto-development");
const metadata = JSON.parse(
  await readFile(path.join(artifact, "metadata.json"), "utf8"),
);
const patch = path.join(artifact, "change.patch");
const patchBytes = await readFile(patch);
if (patchBytes.length === 0 || patchBytes.length > 2 * 1024 * 1024)
  throw new Error("Invalid patch size.");

command("git", ["apply", "--check", "--index", patch]);
command("git", ["apply", "--index", patch]);
const paths = command("git", ["diff", "--cached", "--name-only", "-z"])
  .split("\0")
  .filter(Boolean);
assertAllowedChanges(paths);
for (const file of paths) {
  const staged = command("git", ["ls-files", "--stage", "--", file]);
  if (staged && !/^(100644|100755) /.test(staged))
    throw new Error(`Unsupported staged file type: ${file}`);
}

const branch = `codex/auto-${runId}-${attempt}`;
const botName = `${slug}[bot]`;
const userId = command("gh", ["api", `/users/${botName}`, "--jq", ".id"]);
if (!/^\d+$/.test(userId)) throw new Error("Invalid GitHub App bot user ID.");
command("git", ["config", "user.name", botName]);
command("git", [
  "config",
  "user.email",
  `${userId}+${botName}@users.noreply.github.com`,
]);
command("git", ["switch", "-c", branch]);
command("git", ["commit", "-m", `Implement autonomous request ${runId}`]);
command("git", ["push", "-u", "origin", branch]);

const title =
  typeof metadata.request?.title === "string"
    ? metadata.request.title.slice(0, 180)
    : "Development request";
const source =
  typeof metadata.request?.source === "string" ? metadata.request.source : "";
const summary =
  typeof metadata.summary === "string" ? metadata.summary.slice(0, 15_000) : "";
const checkResult = env("CHECK_RESULT");
const check =
  checkResult === "success"
    ? "Passed"
    : "Failed or unavailable; review required";
const body = [
  `Source: ${source}`,
  `Local \`pnpm run check\`: **${check}**`,
  "",
  "## Codex summary",
  "",
  summary || "No summary was produced.",
  "",
  `Workflow run: https://github.com/zzmelody/aura/actions/runs/${runId}`,
].join("\n");
const bodyFile = path.join(artifact, "pull-request.md");
await writeFile(bodyFile, body, "utf8");
const prArgs = [
  "pr",
  "create",
  "--base",
  "main",
  "--head",
  branch,
  "--title",
  `Automated: ${title}`,
  "--body-file",
  bodyFile,
];
if (checkResult !== "success") prArgs.push("--draft");
const prUrl = command("gh", prArgs);
console.log(`Created ${prUrl}`);
if (process.env.GITHUB_STEP_SUMMARY)
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `Created ${prUrl}\n`, {
    flag: "a",
  });
