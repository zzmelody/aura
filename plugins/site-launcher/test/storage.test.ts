import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSiteProject,
  normalizeSiteProjects,
} from "../client/src/site.ts";

test("site project storage keeps a complete runnable project", () => {
  assert.deepEqual(
    normalizeSiteProject({
      directory: "/Users/me/site",
      name: "my-site",
      packageManager: "pnpm",
      scripts: ["dev", "build"],
      script: "dev",
      url: "http://127.0.0.1:5173",
    }),
    {
      id: "/Users/me/site",
      directory: "/Users/me/site",
      name: "my-site",
      packageManager: "pnpm",
      scripts: ["dev", "build"],
      script: "dev",
      url: "http://127.0.0.1:5173",
    },
  );
});

test("site project storage rejects an incomplete or unsupported project", () => {
  assert.equal(
    normalizeSiteProject({
      directory: "/Users/me/site",
      name: "my-site",
      packageManager: "cargo",
      scripts: ["dev"],
      script: "dev",
      url: "http://127.0.0.1:5173",
    }),
    null,
  );
  assert.equal(
    normalizeSiteProject({
      directory: "/Users/me/site",
      name: "my-site",
      packageManager: "pnpm",
      scripts: ["build"],
      script: "dev",
      url: "http://127.0.0.1:5173",
    }),
    null,
  );
});

test("site project storage migrates legacy records and deduplicates directories", () => {
  const project = {
    directory: "/Users/me/site",
    name: "my-site",
    packageManager: "pnpm",
    scripts: ["dev"],
    script: "dev",
    url: "http://127.0.0.1:5173",
  };
  assert.deepEqual(
    normalizeSiteProjects([project, { ...project, name: "new-name" }]),
    [{ ...project, id: project.directory, name: "new-name" }],
  );
});
