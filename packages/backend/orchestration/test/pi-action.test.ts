import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildArgs,
  parseEventState,
  resolveConfig,
  runPi,
} from "../action/pi/pi.action.js";

test("pi folds a completed JSONL turn", () => {
  const result = parseEventState([
    {
      type: "session",
      id: "00000000-0000-4000-8000-000000000001",
      cwd: "/workspace",
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "toolCall", name: "read" },
          { type: "text", text: "已完成检查。" },
        ],
      },
      usage: { totalTokens: 12 },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.protocolComplete, true);
  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.finalText, "已完成检查。");
  assert.deepEqual(result.toolCalls, ["read"]);
  assert.deepEqual(result.usage, { totalTokens: 12 });
});

test("pi treats an error stop as failed and preserves the provider error", () => {
  const result = parseEventState([
    { type: "session", id: "00000000-0000-4000-8000-000000000002" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider unavailable",
        content: [],
      },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.protocolComplete, true);
  assert.equal(result.terminalStatus, "failed");
  assert.equal(result.terminalError, "provider unavailable");
});

test("pi keeps an incomplete stream incomplete", () => {
  const result = parseEventState([
    { type: "session", id: "00000000-0000-4000-8000-000000000003" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
      },
    },
  ]);
  assert.equal(result.protocolComplete, false);
  assert.equal(result.terminalStatus, "incomplete");
});

test("pi builds a generic isolated invocation from explicit resources", () => {
  const args = buildArgs(
    { extensions: ["/opt/pi/example.js"], skills: ["/opt/pi/example-skill"] },
    {
      prompt: "Inspect this workspace",
      provider: "openai",
      model: "gpt-example",
      thinking: "high",
      isolated: true,
      contextFiles: false,
      approveProject: true,
      tools: ["read", "grep"],
      excludeTools: ["bash"],
      systemPrompt: "Be precise.",
      appendSystemPrompt: ["Return a concise result."],
      extraArgs: ["--verbose"],
    },
    { mode: "create", id: "00000000-0000-4000-8000-000000000004" },
    "/workspace/.aura/pi/sessions",
  );

  assert.deepEqual(args.slice(0, 3), ["--mode", "json", "--print"]);
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--approve"));
  assert.ok(args.includes("/opt/pi/example.js"));
  assert.ok(args.includes("read,grep"));
  assert.equal(args.at(-1), "Inspect this workspace");
  assert.equal(
    args.some((value) => /ange|gamegen|anchemy/i.test(value)),
    false,
  );
});

test("pi refuses extra flags owned by the Action", () => {
  assert.throws(
    () =>
      buildArgs(
        { extensions: [], skills: [] },
        { prompt: "hello", extraArgs: ["--api-key=secret"] },
        { mode: "create", id: "00000000-0000-4000-8000-000000000005" },
        "/sessions",
      ),
    /不能覆盖 Pi Action 管理的参数/u,
  );
});

test("pi resolves its executable and resources without project-specific settings", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aura-pi-action-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const piPath = join(root, "pi.js");
  const agentDirectory = join(root, "agent");
  const extension = join(root, "extension.js");
  const skill = join(root, "skill");
  await Promise.all([
    writeFile(piPath, "// test Pi entry\n"),
    mkdir(agentDirectory),
    writeFile(extension, "// test extension\n"),
    mkdir(skill),
  ]);

  const config = await resolveConfig(
    {
      piPath,
      agentDirectory,
      extensions: [extension],
      skills: [skill],
    },
    {},
  );

  const canonicalPiPath = await realpath(piPath);
  assert.equal(config.piPath, canonicalPiPath);
  assert.equal(config.command, await realpath(process.execPath));
  assert.deepEqual(config.prefixArgs, [canonicalPiPath]);
  assert.equal(config.agentDirectory, await realpath(agentDirectory));
  assert.deepEqual(config.extensions, [await realpath(extension)]);
  assert.deepEqual(config.skills, [await realpath(skill)]);
});

test("pi invokes a CLI process and folds its JSONL result", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aura-pi-process-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const piPath = join(root, "pi.js");
  await writeFile(
    piPath,
    `
const args = process.argv.slice(2);
const sessionId = args[args.indexOf("--session-id") + 1];
const events = [
  { type: "session", id: sessionId, cwd: process.cwd() },
  { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "generic pi result" }] }, usage: { totalTokens: 7 } },
  { type: "agent_end", messages: [] },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`,
  );
  const config = await resolveConfig({ piPath }, {});
  const controller = new AbortController();

  const result = await runPi(
    { cwd: root, callId: "test-call", signal: controller.signal },
    config,
    { prompt: "Run a generic task", isolated: true },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "generic pi result");
  assert.deepEqual(result.usage, { totalTokens: 7 });
  assert.match(await readFile(result.jsonlPath, "utf8"), /generic pi result/u);
});
