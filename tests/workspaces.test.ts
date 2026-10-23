import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspaces } from "../scripts/check-workspaces.ts";

async function fixture(
  t,
  {
    clientDependency = { "@aura/core": "workspace:*" },
    clientSource = 'import { value } from "@aura/core";',
    client = {},
    core = {},
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "aura-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = (path, value) =>
    writeFile(join(root, path), JSON.stringify(value));
  for (const path of [
    "apps/mobile",
    "apps/server",
    "packages/frontend/ui",
    "packages/backend/service",
    "packages/shared/core",
  ])
    await mkdir(join(root, path), { recursive: true });
  await json("package.json", {
    private: true,
    workspaces: [
      "apps/*",
      "packages/frontend/*",
      "packages/backend/*",
      "packages/shared/*",
    ],
  });
  await json("apps/mobile/package.json", {
    name: "@aura/mobile",
    version: "0.1.0",
    private: true,
    aura: { kind: "app", platform: "mobile" },
    dependencies: clientDependency,
    ...client,
  });
  await json("apps/server/package.json", {
    name: "@aura/server",
    version: "0.1.0",
    private: true,
    aura: { kind: "app", platform: "server" },
  });
  await json("packages/frontend/ui/package.json", {
    name: "@aura/ui",
    version: "0.1.0",
    private: true,
    aura: { layer: "frontend", kind: "library" },
    exports: { ".": "./index.ts" },
  });
  await json("packages/backend/service/package.json", {
    name: "@aura/service",
    version: "0.1.0",
    private: true,
    aura: { layer: "backend", kind: "library" },
    exports: { ".": "./index.ts" },
  });
  await json("packages/shared/core/package.json", {
    name: "@aura/core",
    version: "0.1.0",
    private: true,
    aura: { layer: "shared", kind: "library" },
    exports: { ".": "./index.ts" },
    ...core,
  });
  await writeFile(join(root, "apps/mobile/index.ts"), clientSource);
  await writeFile(join(root, "apps/server/index.ts"), "export {};\n");
  await writeFile(join(root, "packages/frontend/ui/index.ts"), "export {};\n");
  await writeFile(
    join(root, "packages/backend/service/index.ts"),
    "export {};\n",
  );
  await writeFile(
    join(root, "packages/shared/core/index.ts"),
    "export const value = 1;\n",
  );
  return root;
}

test("workspace gate accepts application outputs and public library imports", async (t) => {
  assert.deepEqual(await checkWorkspaces(await fixture(t)), []);
});

test("workspace gate accepts explicit TypeScript exports", async (t) => {
  const root = await fixture(t, {
    core: {
      exports: {
        ".": "./index.ts",
      },
    },
  });
  assert.deepEqual(await checkWorkspaces(root), []);
});

test("workspace gate rejects undeclared and private imports", async (t) => {
  const root = await fixture(t, {
    clientDependency: {},
    clientSource:
      'import "@aura/core/private"; import "../../packages/shared/core/index.ts";',
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
        core: { dependencies: { "@aura/mobile": "workspace:*" } },
      }),
    )
  ).join("\n");
  assert.match(errors, /cannot depend on application/);
  assert.match(errors, /dependency cycle/);
});

test("workspace gate enforces application and library layer direction", async (t) => {
  const mobileErrors = (
    await checkWorkspaces(
      await fixture(t, {
        clientDependency: { "@aura/service": "workspace:*" },
      }),
    )
  ).join("\n");
  assert.match(mobileErrors, /mobile applications cannot depend on backend/);

  const libraryErrors = (
    await checkWorkspaces(
      await fixture(t, {
        core: { dependencies: { "@aura/ui": "workspace:*" } },
      }),
    )
  ).join("\n");
  assert.match(libraryErrors, /shared packages cannot depend on frontend/);
});

test("workspace gate enforces app metadata", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, {
        client: {
          aura: { kind: "library", platform: "watch", layer: "frontend" },
        },
      }),
    )
  ).join("\n");
  assert.match(errors, /aura.kind must be app/);
  assert.match(errors, /aura.platform must be web, mobile, desktop or server/);
  assert.match(errors, /applications do not declare aura.layer/);
});

test("workspace gate enforces library metadata, versions and exports", async (t) => {
  const errors = (
    await checkWorkspaces(
      await fixture(t, {
        clientDependency: {
          "@aura/core": "0.1.0",
          "@aura/missing": "workspace:*",
        },
        core: {
          aura: { layer: "backend", kind: "app", platform: "server" },
          exports: { ".": "./missing.ts" },
        },
      }),
    )
  ).join("\n");
  assert.match(errors, /aura.layer must be shared/);
  assert.match(errors, /packages must declare aura.kind as library/);
  assert.match(errors, /libraries do not declare aura.platform/);
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

test("workspace gate rejects mjs package sources", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "packages/shared/core/legacy.mjs"),
    "export const legacy = true;\n",
  );
  const errors = (await checkWorkspaces(root)).join("\n");
  assert.match(errors, /\.mjs sources are forbidden/);
});

test("workspace gate excludes desktop distribution plugins from application source checks", async (t) => {
  const root = await fixture(t);
  const app = join(root, "apps/desktop");
  await mkdir(join(app, "dist-host/plugins/example"), { recursive: true });
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "@aura/desktop",
      private: true,
      version: "0.1.0",
      aura: { kind: "app", platform: "desktop" },
    }),
  );
  await writeFile(
    join(app, "dist-host/plugins/example/provider.js"),
    'import "@aura/third-party-plugin-peer";',
  );
  assert.deepEqual(await checkWorkspaces(root), []);
});
