import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGeneratedPaths,
  completeRequirement,
  parseRequirement,
  requirementDigest,
} from "../scripts/ci/requirements-ci-core.ts";

const source = [
  "---",
  "status: 待处理",
  "visual: true",
  "---",
  "# Add a visible result",
  "",
  "## 验收标准",
  "",
  "- The expected result appears in an actual screenshot.",
  "",
].join("\n");

test("completion changes only the status and preserves the requirement digest", () => {
  const requirement = parseRequirement("docs/requirements/REQ-1.md", source);
  const completed = completeRequirement(source);
  assert.equal(requirement.status, "待处理");
  assert.equal(requirement.visual, true);
  assert.equal(parseRequirement(requirement.path, completed).status, "已完成");
  assert.equal(requirementDigest(completed), requirement.digest);
  assertGeneratedPaths(["packages/frontend/ui/src/example.ts", requirement.path], requirement, completed);
});

test("invalid paths and missing acceptance criteria are rejected", () => {
  assert.throws(() => parseRequirement("docs/requirements/nested/REQ-1.md", source));
  assert.throws(() => parseRequirement("docs/requirements/REQ-1.md", source.replace("## 验收标准", "## Notes")));
});

test("generated code cannot change CI controls, credentials or other requirements", () => {
  const requirement = parseRequirement("docs/requirements/REQ-1.md", source);
  const completed = completeRequirement(source);
  for (const forbidden of [
    ".github/workflows/auto-develop.yml",
    "scripts/ci/requirements-ci.ts",
    "tools/Run-CodexWithGpuLock.ps1",
    ".aura/credentials.json",
    ".codex/config.toml",
    ".gitmodules",
    "docs/requirements/REQ-2.md",
    "ci-evidence/REQ-1/screen.png",
  ]) {
    assert.throws(() => assertGeneratedPaths([forbidden, requirement.path], requirement, completed), forbidden);
  }
  assert.throws(() => assertGeneratedPaths(["src/example.ts", requirement.path], requirement, completed + "\nextra"));
});
