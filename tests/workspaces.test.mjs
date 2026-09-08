import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspaces } from "../scripts/check-workspaces.mjs";

async function fixture(
  t,
  {
    clientDependency = { "@aura/core": "workspace:*" },
    clientSource = 'import { value } from "@aura/core";',
    core = {},
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "aura-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = (path, value) => writeFile(join(root, path), JSON.stringify(value));
  for (const path of [
    "packages/frontend/client",
    "packages/backend/service",
    "packages/shared/core",
  ])
    await mkdir(join(root, path), { recursive: true });
  await json("package.json", {
    private: true,
    workspaces: [
      "packages/frontend/*",
      "packages/backend/*",
      "packages/shared/*",
    ],
  });
  await json("packages/frontend/client/package.json", {
    name: "@aura/client",
    version: "0.1.0",
    private: true,
    aura: { layer: "frontend", kind: "app" },
    dependencies: clientDependency,
  });
  await json("packages/backend/service/package.json", {
    name: "@aura/service",
    version: "0.1.0",
    private: true,
    aura: { layer: "backend", kind: "app" },
  });
  await json("packages/shared/core/package.json", {
    name: "@aura/core",
    version: "0.1.0",
    private: true,
    aura: { layer: "shared", kind: "library" },
    exports: { ".": "./index.mjs" },
    ...core,
  });
  await writeFile(join(root, "packages/frontend/client/index.ts"), clientSource);
  await writeFile(join(root, "packages/backend/service/index.mjs"), "export {};\n");
  await writeFile(join(root, "packages/shared/core/index.mjs"), "export const value = 1;\n");
  return root;
}

test("workspace gate accepts declared public imports", async (t) => {
  assert.deepEqual(await checkWorkspaces(await fixture(t)), []);
});

test("workspace gate rejects undeclared and private imports", async (t) => {
  const root = await fixture(t, {
    clientDependency: {},
    clientSource: 'import "@aura/core/private"; import "../../shared/core/index.mjs";',
  });
  const errors = (await checkWorkspaces(root)).join("\n");
  assert.match(errors, /undeclared dependency/);
  assert.match(errors, /not a public export/);
  assert.match(errors, /cross-package relative import/);
});

test("workspace gate rejects application dependencies and cycles", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, {
        core: { dependencies: { "@aura/client": "workspace:*" } },
      }),
    )
  ).join("\n");
  assert.match(errors, /cannot depend on application/);
  assert.match(errors, /shared packages cannot depend on frontend/);
  assert.match(errors, /dependency cycle/);
});

test("workspace gate enforces layer direction", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, { clientDependency: { "@aura/service": "workspace:*" } }),
    )
  ).join("\n");
  assert.match(errors, /frontend packages cannot depend on backend/);
  assert.match(errors, /cannot depend on application/);
});

test("workspace gate rejects metadata, versions and missing exports", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, {
        clientDependency: { "@aura/core": "0.1.0", "@aura/missing": "workspace:*" },
        core: {
          aura: { layer: "backend", kind: "library" },
          exports: { ".": "./missing.mjs" },
        },
      }),
    )
  ).join("\n");
  assert.match(errors, /aura.layer must be shared/);
  assert.match(errors, /unknown workspace/);
  assert.match(errors, /must use workspace/);
  assert.match(errors, /missing export file/);
});

test("workspace gate rejects direct pi-ai dependencies", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, {
        clientDependency: { "@earendil-works/pi-ai": "0.84.4" },
        clientSource: 'import "@earendil-works/pi-ai";',
      }),
    )
  ).join("\n");
  assert.match(errors, /model providers must use DSH/);
});
