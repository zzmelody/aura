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
test("workspace browser selection survives changes to the side conversations", () => {
  const browser = { id: "browser-one", title: "项目预览" };
  const tabs = workspaceToolTabs(
    [{ id: "other-side", title: "旁支", createdAt: 1 }],
    [terminal],
    [browser],
  );
  assert.equal(selectedToolId(tabs, browser.id), browser.id);
  assert.deepEqual(tabs.at(-1), { ...browser, kind: "browser" });
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

test("localized default tool labels preserve custom titles, saved names and selection", () => {
  const side = { id: "side", title: "旁支对话", createdAt: 1 };
  const browsers = [
    { id: "blank", title: "浏览器", url: "" },
    { id: "page", title: "浏览器", url: "https://example.com" },
    { id: "custom", title: "用户原文", url: "" },
  ];
  const original = structuredClone({ side, browsers });
  const tabs = workspaceToolTabs([side], [terminal], browsers, (key) =>
    key === "browser" ? "Browser" : "New side conversation",
  );
  assert.deepEqual(
    tabs.map((tab) => tab.title),
    ["New side conversation", "PowerShell", "Browser", "浏览器", "用户原文"],
  );
  assert.equal(selectedToolId(tabs, "blank"), "blank");
  assert.deepEqual({ side, browsers }, original);
});
