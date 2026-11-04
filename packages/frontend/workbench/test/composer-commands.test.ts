import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerEntries,
  composerIndex,
  skillDraft,
} from "../src/features/coding/composer-commands.ts";

const catalog = {
  query: "",
  running: false,
  canRunFlow: true,
  skills: [
    { name: "review", description: "检查界面" },
    { name: "model", description: "A skill cannot shadow a built-in command" },
  ],
  flows: [
    {
      id: "video-offline",
      title: "视频旧版",
      description: "",
      available: false,
    },
    {
      id: "video",
      title: "视频生成",
      description: "制作短片",
      available: true,
    },
  ],
};

test("the slash root stays compact and opens separate command, skill and flow catalogs", () => {
  const root = composerEntries(catalog);
  assert.deepEqual(
    root.map((entry) => entry.group),
    ["commands", "skills", "flows"],
  );
  assert.deepEqual(
    root.map((entry) => entry.kind === "group" && entry.count),
    [4, 1, 2],
  );
  const flows = composerEntries({ ...catalog, group: "flows" });
  assert.deepEqual(
    flows.map((entry) => [entry.name, Boolean(entry.disabled)]),
    [
      ["video", false],
      ["video-offline", true],
    ],
  );
  assert.equal(catalog.flows[0]?.id, "video-offline");
});

test("search reaches every category and command names take precedence over skills", () => {
  assert.deepEqual(
    composerEntries({ ...catalog, query: "检查" }).map((entry) => entry.name),
    ["review"],
  );
  assert.deepEqual(
    composerEntries({ ...catalog, query: "VIDEO" }).map((entry) => entry.name),
    ["video", "video-offline"],
  );
  assert.deepEqual(
    composerEntries({ ...catalog, query: "model" }).map((entry) => entry.kind),
    ["command"],
  );
  assert.deepEqual(
    composerEntries({ ...catalog, query: "skills" }).map((entry) => entry.kind),
    ["group"],
  );
  assert.equal(composerEntries({ ...catalog, query: "missing" }).length, 0);
  const commands = composerEntries({
    ...catalog,
    group: "commands",
    running: true,
  });
  assert.equal(
    Boolean(commands.find((entry) => entry.name === "model")?.disabled),
    false,
  );
  assert.equal(
    commands.find((entry) => entry.name === "stop")?.disabled,
    false,
  );
});

test("navigation handles an empty or shrinking catalog and skill completion preserves a typed request", () => {
  assert.equal(composerIndex(9, 1, 0), 0);
  assert.equal(composerIndex(9, 1, 2), 0);
  assert.equal(composerIndex(0, -1, 3), 2);
  assert.equal(skillDraft("review", "/rev"), "/review ");
  assert.equal(skillDraft("review", "检查当前界面"), "/review 检查当前界面");
});

test("compact is an idle-only native command and cannot be shadowed by a skill", () => {
  const idle = composerEntries({
    ...catalog,
    query: "compact",
    skills: [{ name: "compact", description: "collision" }],
  });
  assert.equal(idle.length, 1);
  assert.equal(idle[0]?.kind, "command");
  assert.equal(idle[0]?.disabled, false);
  assert.equal(
    composerEntries({ ...catalog, query: "compact", running: true })[0]
      ?.disabled,
    true,
  );
});
