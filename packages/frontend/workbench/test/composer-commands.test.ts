import assert from "node:assert/strict";
import { test } from "node:test";
import { language } from "@aura/i18n/runtime";
import {
  collaborationCommand,
  collaborationPrefix,
  commandDeletionRange,
  composerEntries,
  composerIndex,
  insertCollaborationCommand,
  insertSkill,
  replaceDraftRange,
  skillReferences,
  slashAtCaret,
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

test("command search uses the selected language while aliases and user entries retain their values", async () => {
  await language.ready;
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    const translate = language.i18n.getFixedT(locale, "conversation");
    const entries = composerEntries({
      ...catalog,
      group: "commands",
      translate,
    });
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["plan", "goal", "compact", "model", "stop", "clear"],
    );
    const title = translate("selectModel");
    assert.notEqual(title, "selectModel");
    const found = composerEntries({ ...catalog, query: title, translate });
    assert.ok(
      found.some(
        (entry) => entry.kind === "command" && entry.command === "model",
      ),
      locale,
    );
    assert.equal(
      composerEntries({ ...catalog, group: "skills", translate })[0]
        ?.description,
      "检查界面",
    );
    assert.equal(
      composerEntries({ ...catalog, group: "flows", translate })[0]?.title,
      "视频生成",
    );
  }
});

test("the slash root stays compact and opens separate command, skill and flow catalogs", () => {
  const root = composerEntries(catalog);
  assert.deepEqual(
    root.map((entry) => entry.group),
    ["commands", "skills", "flows"],
  );
  assert.deepEqual(
    root.map((entry) => entry.kind === "group" && entry.count),
    [6, 1, 2],
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

test("plan and goal commands distinguish objectives from session controls", () => {
  assert.deepEqual(collaborationCommand("/plan Check the design"), {
    action: "plan",
    prompt: "Check the design",
  });
  assert.deepEqual(collaborationCommand("/plan off"), { action: "execute" });
  assert.deepEqual(collaborationCommand("/goal Verify\nall steps"), {
    action: "goal",
    prompt: "Verify\nall steps",
  });
  for (const action of ["pause", "resume", "clear"])
    assert.deepEqual(collaborationCommand(`/goal ${action}`), { action });
  assert.equal(collaborationCommand("/goals"), undefined);
});

test("plan and goal picks preserve draft arguments and stay inert without a prompt", () => {
  assert.deepEqual(
    insertCollaborationCommand(
      "  /pla\n检查\n方案",
      { start: 0, end: 6 },
      "plan",
    ),
    {
      draft: "/plan\n检查\n方案",
      caret: 5,
    },
  );
  assert.deepEqual(
    insertCollaborationCommand("  检查方案", { start: 0, end: 0 }, "goal"),
    {
      draft: "/goal  检查方案",
      caret: 6,
    },
  );
  assert.deepEqual(collaborationCommand("/plan\n检查\n方案"), {
    action: "plan",
    prompt: "检查\n方案",
  });
  assert.equal(collaborationCommand("/goal "), undefined);
  assert.equal(collaborationPrefix("正文 /plan 检查"), undefined);
  assert.equal(collaborationPrefix("/planet"), undefined);
});

test("plan and goal picked after typed text move to the front and keep the text as the prompt", () => {
  const names = composerEntries({ ...catalog, group: "commands" }).map(
    ({ name }) => name,
  );
  assert.ok(names.includes("plan") && names.includes("goal"));
  const typed = "检查方案 /pl";
  const slash = slashAtCaret(typed, { start: typed.length, end: typed.length });
  assert.ok(slash);
  const edit = insertCollaborationCommand(typed, slash, "plan");
  assert.deepEqual(edit, { draft: "/plan 检查方案 ", caret: 11 });
  assert.deepEqual(collaborationCommand(edit.draft), {
    action: "plan",
    prompt: "检查方案",
  });
  // Text after the slash token stays in place behind the caret.
  assert.deepEqual(
    insertCollaborationCommand("检查 /go 方案", { start: 3, end: 6 }, "goal"),
    { draft: "/goal 检查  方案", caret: 9 },
  );
  // Switching modes replaces the earlier prefix instead of stacking it.
  assert.deepEqual(
    insertCollaborationCommand("/goal 检查 /pl", { start: 9, end: 12 }, "plan"),
    { draft: "/plan 检查 ", caret: 9 },
  );
});

test("deleting a command beside the caret leaves the draft arguments as plain text", () => {
  const draft = "/plan 检查方案";
  const command = collaborationPrefix(draft);
  assert.deepEqual(command, { start: 0, end: 5 });
  assert.ok(command);
  for (const [caret, backward] of [
    [6, true],
    [0, false],
  ] as const) {
    const range = commandDeletionRange(
      draft,
      command,
      { start: caret, end: caret },
      backward,
    );
    assert.ok(range);
    const remaining = replaceDraftRange(draft, range, "").draft;
    assert.equal(remaining, "检查方案");
    assert.equal(collaborationCommand(remaining), undefined);
  }
  assert.equal(
    commandDeletionRange(draft, command, { start: 7, end: 7 }, true),
    undefined,
  );
  assert.equal(
    commandDeletionRange(draft, command, { start: 0, end: 2 }, false),
    undefined,
  );
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

test("navigation handles an empty or shrinking catalog", () => {
  assert.equal(composerIndex(9, 1, 0), 0);
  assert.equal(composerIndex(9, 1, 2), 0);
  assert.equal(composerIndex(0, -1, 3), 2);
});

test("slash completion tracks the caret across multiline drafts and preserves the text on either side", () => {
  const draft = "检查首页\n再用 /rev 看看";
  const caret = draft.indexOf(" 看看");
  const token = slashAtCaret(draft, { start: caret, end: caret });
  assert.deepEqual(token, {
    start: draft.indexOf("/"),
    end: caret,
    query: "rev",
  });
  assert.ok(token);
  assert.deepEqual(insertSkill(draft, token, "review"), {
    draft: "检查首页\n再用 /review 看看",
    caret: "检查首页\n再用 /review ".length,
  });
  assert.equal(
    replaceDraftRange(draft, token, "").draft,
    "检查首页\n再用  看看",
  );
  assert.equal(
    slashAtCaret(draft, { start: caret - 3, end: caret }),
    undefined,
  );
  assert.equal(
    slashAtCaret(draft, { start: draft.length, end: draft.length }),
    undefined,
  );
});

test("slash completion allows punctuation boundaries without opening inside paths or URLs", () => {
  for (const draft of [
    "https:/",
    "https://example.com/a",
    "C:/folder",
    "src/file",
    "//comment",
  ])
    assert.equal(
      slashAtCaret(draft, { start: draft.length, end: draft.length }),
      undefined,
      draft,
    );
  assert.deepEqual(slashAtCaret("前面（/计划", { start: 6, end: 6 }), {
    start: 3,
    end: 6,
    query: "计划",
  });
});

test("skill completion adds invocation separators and preserves the suffix after the caret", () => {
  assert.deepEqual(insertSkill("/rev", { start: 0, end: 4 }, "review"), {
    draft: "/review ",
    caret: 8,
  });
  assert.deepEqual(insertSkill("看看 /首页", { start: 3, end: 4 }, "review"), {
    draft: "看看 /review 首页",
    caret: 11,
  });
  assert.deepEqual(
    insertSkill("看看（/rev\n首页", { start: 3, end: 7 }, "review"),
    {
      draft: "看看（ /review\n首页",
      caret: 11,
    },
  );
});

test("only complete and available skill references get decorated, including inline references", () => {
  const draft = "/review 看看\n再用 /review /model /review.md /unknown";
  assert.deepEqual(skillReferences(draft, catalog.skills), [
    { start: 0, end: 7 },
    { start: 14, end: 21 },
  ]);
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
