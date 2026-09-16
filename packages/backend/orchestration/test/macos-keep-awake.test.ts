import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { manageKeepAwake } from "../action/macos-keep-awake/macos-keep-awake.action.js";

test(
  "macOS keep-awake Action owns one detached caffeinate process",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-keep-awake-"));
    const context = {
      cwd: root,
      signal: new AbortController().signal,
    };
    try {
      assert.deepEqual(await manageKeepAwake(context, "status"), {
        operation: "status",
        active: false,
      });

      const started = await manageKeepAwake(context, "start");
      assert.equal(started.active, true);
      assert.equal(typeof started.pid, "number");
      assert.match(started.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

      const duplicate = await manageKeepAwake(context, "start");
      assert.equal(duplicate.pid, started.pid);
      assert.equal(duplicate.startedAt, started.startedAt);

      const status = await manageKeepAwake(context, "status");
      assert.equal(status.active, true);
      assert.equal(status.pid, started.pid);

      assert.deepEqual(await manageKeepAwake(context, "stop"), {
        operation: "stop",
        active: false,
      });
      assert.deepEqual(await manageKeepAwake(context, "stop"), {
        operation: "stop",
        active: false,
      });
    } finally {
      await manageKeepAwake(context, "stop").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
