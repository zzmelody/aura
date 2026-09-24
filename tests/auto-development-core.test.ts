import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedChanges,
  documentRequest,
  isRequestDocument,
  issueRequest,
} from "../scripts/ci/auto-development-core.ts";

test("only owner-authored issues become development requests", () => {
  const issue = {
    issue: {
      number: 42,
      title: "Add export",
      body: "Export the report.",
      user: { login: "zzmelody" },
    },
  };
  assert.equal(
    issueRequest(issue, "zzmelody").source,
    "https://github.com/zzmelody/aura/issues/42",
  );
  assert.throws(() =>
    issueRequest(
      { issue: { ...issue.issue, user: { login: "visitor" } } },
      "zzmelody",
    ),
  );
  assert.throws(() =>
    issueRequest({ issue: { ...issue.issue, body: "" } }, "zzmelody"),
  );
});

test("document requests stay inside the dedicated Markdown path", () => {
  assert.equal(isRequestDocument("docs/requests/report.md"), true);
  assert.equal(isRequestDocument("docs/requests/../architecture.md"), false);
  assert.equal(isRequestDocument("docs/requests/run.ps1"), false);
  assert.equal(
    documentRequest(
      [{ path: "docs/requests/report.md", body: "Build report" }],
      "a".repeat(40),
    ).kind,
    "document",
  );
});

test("automation and credential paths cannot be published", () => {
  assert.doesNotThrow(() =>
    assertAllowedChanges(["packages/frontend/ui/src/Report.tsx"]),
  );
  for (const path of [
    ".github/workflows/auto-develop.yml",
    "scripts/ci/auto-develop.ts",
    "AGENTS.md",
    "docs/requests/report.md",
    ".env.local",
    "apps/web/.env.local",
    "packages/frontend/ui/AGENTS.md",
  ]) {
    assert.throws(() => assertAllowedChanges([path]), /protected path/);
  }
});
