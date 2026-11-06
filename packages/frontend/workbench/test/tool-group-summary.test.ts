import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeToolGroup,
  describeToolGroup,
  type ToolEntry,
} from "../src/features/coding/turns.ts";

const tool = (callId: string, state: ToolEntry["state"]): ToolEntry => ({
  callId,
  name: "read",
  state,
  startedAt: 1,
});

test("a running group reports its latest active call without hiding earlier failures", () => {
  const tools = [
    tool("done", "ok"),
    tool("failed", "failed"),
    tool("running-a", "running"),
    tool("running-b", "running"),
  ];
  const summary = summarizeToolGroup(tools);
  assert.equal(summary.total, 4);
  assert.equal(summary.finished, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.state, "running");
  assert.equal(summary.active, tools[3]);
  assert.equal(tools[2]!.state, "running");
});

test("settled groups distinguish successful, failed and interrupted operations", () => {
  assert.deepEqual(summarizeToolGroup([tool("ok", "ok")]), {
    total: 1,
    finished: 1,
    failed: 0,
    stopped: 0,
    state: "ok",
  });
  const interrupted = summarizeToolGroup([
    tool("ok", "ok"),
    tool("stopped", "stopped"),
  ]);
  assert.equal(interrupted.state, "stopped");
  assert.equal(interrupted.stopped, 1);
  const failed = summarizeToolGroup([
    tool("failed", "failed"),
    tool("stopped", "stopped"),
  ]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failed, 1);
  assert.equal(failed.stopped, 1);
  assert.equal(failed.finished, 2);
  assert.equal(failed.active, undefined);
});

test("an empty group has no active call or invented failure", () => {
  assert.deepEqual(summarizeToolGroup([]), {
    total: 0,
    finished: 0,
    failed: 0,
    stopped: 0,
    state: "ok",
  });
});

test("tool descriptions merge repeated activities and retain the order of work", () => {
  const tools = [
    { ...tool("r1", "ok"), name: "read" },
    { ...tool("r2", "ok"), name: "read" },
    { ...tool("e1", "ok"), name: "edit" },
    { ...tool("e2", "ok"), name: "write" },
    { ...tool("c1", "ok"), name: "bash" },
    { ...tool("c2", "ok"), name: "pwsh" },
  ];
  assert.equal(
    describeToolGroup(tools, "zh-CN"),
    "读取了文件、修改了文件和运行了命令",
  );
});

test("failed edits are described as attempts until one edit succeeds", () => {
  const failed = { ...tool("edit", "failed"), name: "edit" };
  assert.equal(describeToolGroup([failed], "zh-CN"), "尝试修改文件");
  assert.equal(
    describeToolGroup(
      [failed, { ...failed, callId: "ok", state: "ok" }],
      "zh-CN",
    ),
    "修改了文件",
  );
});

test("unknown tools get a quiet generic description and empty groups have none", () => {
  assert.equal(
    describeToolGroup(
      [{ ...tool("custom", "ok"), name: "custom-tool" }],
      "zh-CN",
    ),
    "调用了工具",
  );
  assert.equal(describeToolGroup([]), "");
});
