import assert from "node:assert/strict";
import test from "node:test";
import {
  selectedToolId,
  workspaceToolTabs,
} from "../src/features/coding/tool-tabs.ts";
import type { WorkspaceTerminalInfo } from "@aura/protocol/types";

const terminal: WorkspaceTerminalInfo = {
  id: "terminal-one",
  projectId: "space",
  title: "PowerShell",
  directory: "fixture",
  createdAt: 1,
  status: "running",
  activity: "idle",
};
test("workspace terminal selection survives switching between main conversations", () => {
  const first = workspaceToolTabs(
    [{ id: "side-a", title: "第一条思路", createdAt: 1 }],
    [terminal],
  );
  const second = workspaceToolTabs(
    [{ id: "side-b", title: "第二条思路", createdAt: 1 }],
    [terminal],
  );
  assert.equal(selectedToolId(first, terminal.id), terminal.id);
  assert.equal(selectedToolId(second, terminal.id), terminal.id);
  assert.equal(selectedToolId(second, "side-a"), "side-b");
  assert.equal(selectedToolId([], terminal.id), undefined);
});
test("tool labels distinguish terminal instances and project legacy side names without mutations", () => {
  const side = { id: "side-a", title: "旁支对话", createdAt: 1 };
  const tabs = workspaceToolTabs(
    [side],
    [terminal, { ...terminal, id: "terminal-two", status: "exited" }],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.title),
    ["新侧边对话", "PowerShell 1", "PowerShell 2"],
  );
  assert.equal(side.title, "旁支对话");
  assert.equal(tabs[2]?.status, "exited");
});
