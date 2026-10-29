import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationHost } from "../src/index.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

/**
 * Workspaces are coding projects in DSH's registry. Configuring one's
 * directory re-registers it under the same title and drops the old record, so
 * the sidebar keeps one entry per workspace.
 */
test(
  "a workspace can be created and pointed at another directory",
  {
    timeout: 120_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-workspace-test-"));
    const first = join(root, "first");
    const second = join(root, "second");
    const flowRoot = join(root, "flow");
    for (const directory of [first, second, flowRoot])
      await mkdir(directory, { recursive: true });
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: "http://127.0.0.1:9/v1",
    });
    try {
      const created = await host.createProject(first, "演示空间");
      const moved = await host.relocateProject(created.id, second);
      assert.equal(moved.directory, await realpath(second));
      assert.equal(moved.title, "演示空间");
      const projects = await host.projects();
      assert.deepEqual(
        projects
          .filter((item) => !item.isDefault)
          .map((item) => item.directory),
        [await realpath(second)],
      );

      // The same directory is a no-op rather than a duplicate.
      const same = await host.relocateProject(moved.id, second);
      assert.equal(same.id, moved.id);

      // A directory owned by another workspace is refused, and both stay.
      const other = await host.createProject(first);
      await assert.rejects(host.relocateProject(moved.id, first), {
        message: /另一个工作空间/u,
      });
      assert.equal((await host.projects()).length, 3);

      // Conversations outside any workspace get a built-in directory.
      assert.ok(
        (await stat(join(root, ".aura", "workspace"))).isDirectory(),
        "the host provisions the default workspace directory",
      );

      // A missing or relative directory never replaces the registration.
      await assert.rejects(
        host.relocateProject(other.id, join(root, "missing")),
      );
      await assert.rejects(host.relocateProject(other.id, "relative/dir"));
      assert.equal((await host.projects()).length, 3);
      const builtIn = (await host.projects()).find((item) => item.isDefault)!;
      await assert.rejects(host.removeProject(builtIn.id));
      await assert.rejects(host.relocateProject(builtIn.id, first));
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
