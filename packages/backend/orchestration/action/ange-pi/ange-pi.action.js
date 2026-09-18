// The Action discovery contract currently loads `.action.js` entries. Keep the
// implementation here until discovery gains a first-class `.action.ts` loader;
// the backend package typecheck still verifies the public Action definition.
// @ts-nocheck
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineAction } from "@aura/orchestration/action";

const PACKAGE_NAMES = [
  "pi-ange-gamegen",
  "pi-subagents",
  "pi-rpiv-todo",
  "pi-anchemy-gateway",
];
const OWNED_FLAGS = new Set([
  "--mode",
  "--print",
  "--session",
  "--session-id",
  "--session-dir",
  "--continue",
  "--resume",
  "--model",
  "--thinking",
  "--name",
  "-m",
  "--provider",
  "--api-key",
  "--no-session",
  "--fork",
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--skill",
  "--tools",
  "--cwd",
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_PROMPT = 200_000;
const MAX_EXTRA_ARGS = 64;

function json(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON。`, { cause: error });
  }
}

async function readJson(path, label, optional = false) {
  try {
    return json(await readFile(path, "utf8"), label);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    if (error?.code === "ENOENT") {
      const missing = new Error(`${label} 不存在：${path}`);
      missing.code = "ENOENT";
      throw missing;
    }
    throw error;
  }
}

function envValue(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function redact(value, secrets) {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join("[REDACTED]");
    try { output = output.split(encodeURIComponent(secret)).join("[REDACTED]"); } catch { /* invalid URI bytes */ }
  }
  return output;
}

function defaultSettingsPath(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Anchemy", "settings.json");
  if (process.platform === "win32")
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Anchemy", "settings.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "anchemy", "settings.json");
}

function setting(raw, camel, env, envName) {
  const value = raw?.[camel];
  if (typeof value === "string" && value.trim()) return value.trim();
  return envValue(env, envName);
}

async function canonical(path, label) {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(`${label} 不可访问：${path}`, { cause: error });
  }
}

async function contained(root, path, label) {
  const base = await canonical(root, `${label} 根目录`);
  const candidate = await canonical(path, label);
  const rel = relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} 超出允许目录：${path}`);
  return candidate;
}

function assertLexicallyContained(root, path, label) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} 超出允许目录：${path}`);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveConfig(input) {
  const env = process.env;
  const settingsPath = resolve(
    input.settingsPath ??
      envValue(env, "AURA_ANCHEMY_SETTINGS_PATH") ??
      envValue(env, "ANCHEMY_SETTINGS_PATH") ??
      defaultSettingsPath(env),
  );
  const raw = (await readJson(settingsPath, "Anchemy settings").catch((error) => {
    if (error?.code === "ENOENT" && envValue(env, "ANCHEMY_ANGE_ROOT")) return {};
    throw error;
  })) ?? {};
  const stateRoot = dirname(settingsPath);
  const angeRoot = resolve(
    setting(raw, "angeRoot", env, "ANCHEMY_ANGE_ROOT") ??
      (() => { throw new Error("未配置 ANGE 根目录；请设置 Anchemy settings 或 ANCHEMY_ANGE_ROOT。"); })(),
  );
  const piBin = resolve(
    setting(raw, "piBin", env, "ANCHEMY_PI_BIN") ??
      (() => { throw new Error("未配置 Pi 可执行文件；请设置 Anchemy settings 或 ANCHEMY_PI_BIN。"); })(),
  );
  const piHostRoot = setting(raw, "piHostRoot", env, "ANCHEMY_PI_HOST_ROOT");
  const model = setting(raw, "model", env, "ANCHEMY_MODEL");
  const thinking = setting(raw, "thinking", env, "ANCHEMY_THINKING");
  const apiBaseUrl = setting(raw, "apiBaseUrl", env, "ANCHEMY_API_BASE_URL");
  const apiKey = setting(raw, "apiKey", env, "ANCHEMY_API_KEY");
  const gatewayContextWindow = envValue(env, "ANCHEMY_GATEWAY_CONTEXT_WINDOW");
  const gatewayMaxTokens = envValue(env, "ANCHEMY_GATEWAY_MAX_TOKENS");
  const watchdogSecs = envValue(env, "ANCHEMY_ANGE_WATCHDOG_SECS") ?? "300";
  const roleDir = join(stateRoot, "roles", "generate");
  const roleSettingsPath = join(roleDir, "settings.json");
  const roleSettings = await readJson(roleSettingsPath, "Anchemy generate role");
  const fingerprint = await readJson(join(roleDir, "fingerprint.json"), "Anchemy generate fingerprint");
  if (fingerprint?.name !== "generate" || fingerprint?.agentDir && resolve(fingerprint.agentDir) !== resolve(roleDir))
    throw new Error("Anchemy generate role 指纹无效；请运行 anchemy provision。");
  const policyPath = join(roleDir, "policy.json");
  const policy = await readFile(policyPath, "utf8");
  const policySha256 = createHash("sha256").update(policy).digest("hex");
  if (fingerprint?.policySha256 && fingerprint.policySha256 !== policySha256)
    throw new Error("Anchemy generate policy 已变化；请运行 anchemy provision。");
  const packages = Array.isArray(roleSettings?.packages) ? roleSettings.packages : [];
  const packageRoots = [];
  for (const packageName of PACKAGE_NAMES) {
    const packageRoot = packages.find((candidate) => typeof candidate === "string" && candidate.endsWith(`${sep}${packageName}`));
    if (!packageRoot) throw new Error(`Anchemy generate role 缺少插件：${packageName}；请运行 provision。`);
    const root = await canonical(packageRoot, `${packageName} 插件`);
    const manifest = await readJson(join(root, "package.json"), `${packageName} manifest`);
    if (manifest?.name !== packageName) throw new Error(`插件 manifest 与角色配置不一致：${packageName}`);
    packageRoots.push(root);
  }
  const gamegenRoot = packageRoots.find((root) => root.endsWith(`${sep}pi-ange-gamegen`));
  const roleFingerprint = fingerprint?.host;
  const hostBin = roleFingerprint?.bin ? await canonical(roleFingerprint.bin, "Pi host") : await canonical(piBin, "Pi");
  const nodeBin = roleFingerprint?.node?.bin ? await canonical(roleFingerprint.node.bin, "Pi Node") : process.execPath;
  const actualPiBin = await canonical(piBin, "Pi settings bin");
  if (roleFingerprint?.bin && hostBin !== actualPiBin)
    throw new Error("Pi settings bin 与 generate role fingerprint 不一致；请重新 provision。");
  if (piHostRoot && !(await isDirectory(piHostRoot))) throw new Error(`Pi host root 不存在：${piHostRoot}`);
  if (!(await isDirectory(angeRoot))) throw new Error(`ANGE 根目录不存在：${angeRoot}`);
  const skills = Array.isArray(fingerprint?.skills) ? fingerprint.skills : [];
  const skillPaths = [];
  for (const skill of skills) {
    if (typeof skill !== "string") continue;
    skillPaths.push(await canonical(skill, "GameGen skill"));
  }
  return {
    settingsPath,
    stateRoot,
    angeRoot: await canonical(angeRoot, "ANGE 根目录"),
    piBin: actualPiBin,
    piHostRoot: piHostRoot ? await canonical(piHostRoot, "Pi host root") : dirname(hostBin),
    hostBin,
    nodeBin,
    model,
    thinking,
    apiBaseUrl,
    apiKey,
    gatewayContextWindow,
    gatewayMaxTokens,
    watchdogSecs,
    roleDir: await canonical(roleDir, "generate role"),
    policyPath: await canonical(policyPath, "generate policy"),
    policySha256,
    packages: packageRoots,
    skills: skillPaths,
    gamegenRoot,
  };
}

async function sessionFileFor(dir, sessionId) {
  if (!sessionId) return undefined;
  if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID。");
  const files = (await readdir(dir)).filter((name) => extname(name) === ".jsonl");
  const matches = [];
  for (const name of files) {
    const file = join(dir, name);
    const line = (await readFile(file, "utf8")).split("\n", 1)[0];
    try {
      const header = JSON.parse(line);
      if (header?.type === "session" && header.id === sessionId) matches.push(file);
    } catch { /* incomplete files are ignored; an exact match is still required */ }
  }
  if (matches.length !== 1) throw new Error(`找不到唯一的 Pi session：${sessionId}`);
  return await canonical(matches[0], "Pi session");
}

function ownedArgName(arg) {
  const name = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
  return name;
}

function buildArgs(config, input, session, sessionDir) {
  const args = ["--mode", "json", "--print"];
  const model = input.model ?? config.model;
  const thinking = input.thinking ?? config.thinking;
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (input.name) args.push("--name", input.name);
  if (session?.mode === "resume") args.push("--session", session.file);
  else args.push("--session-id", session.id);
  args.push("--session-dir", sessionDir);
  args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
  const pluginNames = input.plugins ?? PACKAGE_NAMES;
  if (!Array.isArray(pluginNames) || pluginNames.length === 0 || !pluginNames.includes("pi-ange-gamegen") || pluginNames.some((name) => !PACKAGE_NAMES.includes(name)))
    throw new Error(`plugins 只能是 GameGen 角色插件：${PACKAGE_NAMES.join(", ")}`);
  for (const name of pluginNames) args.push("--extension", config.packages[PACKAGE_NAMES.indexOf(name)]);
  for (const skill of input.skills ?? config.skills) {
    if (typeof skill !== "string" || !isAbsolute(skill)) throw new Error("skills 必须是绝对路径。");
    args.push("--skill", skill);
  }
  if (input.extraArgs !== undefined) {
    if (!Array.isArray(input.extraArgs) || input.extraArgs.length > MAX_EXTRA_ARGS || input.extraArgs.some((value) => typeof value !== "string" || value.length > 2000))
      throw new Error("extraArgs 必须是最多 64 个短字符串。");
    for (const value of input.extraArgs) {
      if (OWNED_FLAGS.has(ownedArgName(value))) throw new Error(`extraArgs 不能覆盖 Pi Action 管理的参数：${value}`);
      args.push(value);
    }
  }
  args.push(input.prompt);
  return args;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

function parseEventState(events) {
  let session;
  let finalText = "";
  let stopReason;
  let terminalError;
  let ended = false;
  let protocolComplete = false;
  const toolCalls = [];
  let usage;
  for (const event of events) {
    if (event.type === "session" && !session) session = event;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = textFromContent(event.message.content);
      if (text.trim()) finalText = text;
      stopReason = event.message.stopReason;
      if (stopReason === "error" && typeof event.message.errorMessage === "string") terminalError = event.message.errorMessage;
      if (Array.isArray(event.message.content)) for (const part of event.message.content) if (part?.type === "toolCall" && typeof part.name === "string") toolCalls.push(part.name);
      if (event.usage) usage = event.usage;
    }
    if (event.type === "agent_end") {
      ended = true;
      if (Array.isArray(event.messages)) {
        const assistant = [...event.messages].reverse().find((message) => message?.role === "assistant");
        if (assistant && !finalText.trim()) finalText = textFromContent(assistant.content);
      }
    }
  }
  protocolComplete = Boolean(session && ended && stopReason);
  const terminalStatus = !protocolComplete ? "incomplete" : stopReason === "stop" || stopReason === "toolUse" ? "completed" : "failed";
  return { session, finalText, stopReason, terminalError, toolCalls, usage, protocolComplete, terminalStatus };
}

async function runPi(ctx, config, input) {
  const cwd = await canonical(input.cwd ?? config.angeRoot, "Pi cwd");
  await contained(config.angeRoot, cwd, "Pi cwd");
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0 || input.prompt.length > MAX_PROMPT)
    throw new Error(`prompt 必须为 1 到 ${MAX_PROMPT} 个字符。`);
  const baseDirectory = await canonical(ctx.cwd, "Aura 工作目录");
  const requestedSessionDir = resolve(baseDirectory, input.sessionDirectory ?? join(baseDirectory, ".aura", "pi", "ange-gamegen", "sessions"));
  assertLexicallyContained(baseDirectory, requestedSessionDir, "sessionDirectory");
  await mkdir(requestedSessionDir, { recursive: true, mode: 0o700 });
  const sessionDir = await contained(baseDirectory, requestedSessionDir, "sessionDirectory");
  const sessionFile = await sessionFileFor(sessionDir, input.sessionId);
  const session = sessionFile ? { mode: "resume", id: input.sessionId, file: sessionFile } : { mode: "create", id: input.sessionId ?? randomUUID() };
  const requestedOutputDirectory = resolve(baseDirectory, input.outputDirectory ?? join(baseDirectory, ".aura", "pi", "ange-gamegen", "runs", ctx.callId));
  assertLexicallyContained(baseDirectory, requestedOutputDirectory, "outputDirectory");
  await mkdir(requestedOutputDirectory, { recursive: true, mode: 0o700 });
  const outputRoot = await contained(baseDirectory, requestedOutputDirectory, "outputDirectory");
  const jsonlPath = join(outputRoot, "events.jsonl");
  const args = buildArgs(config, input, session, sessionDir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:PI_|ANCHEMY_|JITI_|RPIV_|SUBAGENT_|NODE_|BUN_|TS_NODE_|TSX_)/.test(key) && key !== "NODE_EXTRA_CA_CERTS") delete env[key];
  Object.assign(env, {
    PI_CODING_AGENT_DIR: config.roleDir,
    ANCHEMY_PI_ROLE: "generate",
    ANCHEMY_PI_HOST_ROOT: config.piHostRoot,
    ANCHEMY_PI_BIN: config.hostBin,
    ANCHEMY_SUBAGENTS_POLICY: config.policyPath,
    ANCHEMY_SUBAGENTS_POLICY_SHA256: config.policySha256,
    ANCHEMY_GAMEGEN_ROOT: config.gamegenRoot,
    ...(config.apiBaseUrl ? { ANCHEMY_API_BASE_URL: config.apiBaseUrl } : {}),
    ...(config.apiKey ? { ANCHEMY_API_KEY: config.apiKey } : {}),
    ...(config.gatewayContextWindow ? { ANCHEMY_GATEWAY_CONTEXT_WINDOW: config.gatewayContextWindow } : {}),
    ...(config.gatewayMaxTokens ? { ANCHEMY_GATEWAY_MAX_TOKENS: config.gatewayMaxTokens } : {}),
    ANGE_TEST_WATCHDOG_SECS: config.watchdogSecs,
    ...(config.apiBaseUrl && (input.model ?? config.model) ? { ANCHEMY_GATEWAY_MODEL: input.model ?? config.model } : {}),
  });
  const command = config.nodeBin;
  const commandArgs = [config.hostBin, ...args];
  const secrets = [config.apiKey, env.ANCHEMY_API_KEY].filter(Boolean);
  const events = [];
  let pending = "";
  let stderr = "";
  let timedOut = false;
  let exitCode = null;
  let child;
  const timeoutMs = input.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs 必须为 1 到 600000 毫秒。");
  const consume = (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push({ ...JSON.parse(line), recordedAt: new Date().toISOString() }); }
      catch { stderr = `${stderr}\nPi 输出了无法解析的 JSONL。`; }
    }
  };
  const kill = () => {
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { child.kill("SIGTERM"); }
    setTimeout(() => {
      if (child?.exitCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* the process may have exited between the two checks */ }
    }, 5_000).unref();
  };
  await new Promise((resolvePromise, reject) => {
    try {
      child = spawn(command, commandArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) { reject(error); return; }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      exitCode = code;
      resolvePromise();
    });
  });
  consume(pending + "\n");
  await writeFile(
    jsonlPath,
    events.map((event) => redact(JSON.stringify(event), secrets)).join("\n") + (events.length ? "\n" : ""),
    { mode: 0o600 },
  );
  if (ctx.signal.aborted) throw new Error("Pi Action 已取消。");
  const parsed = parseEventState(events);
  const ok = exitCode === 0 && !timedOut && parsed.protocolComplete && parsed.terminalStatus === "completed";
  if (!ok && !parsed.finalText && parsed.terminalError) stderr = `${stderr}\n${parsed.terminalError}`;
  let resolvedSessionFile;
  try { resolvedSessionFile = (await sessionFileFor(sessionDir, parsed.session?.id ?? session.id)); } catch { /* preserve a useful result even after an early Pi failure */ }
  return {
    ok,
    status: timedOut ? "timeout" : ctx.signal.aborted ? "cancelled" : ok ? "completed" : parsed.terminalStatus,
    sessionId: parsed.session?.id ?? session.id,
    sessionFile: resolvedSessionFile,
    finalText: redact(parsed.finalText, secrets),
    toolCalls: parsed.toolCalls,
    stopReason: parsed.stopReason,
    ...(parsed.terminalError ? { terminalError: redact(parsed.terminalError, secrets) } : {}),
    ...(exitCode === null ? {} : { exitCode }),
    timedOut,
    protocolComplete: parsed.protocolComplete,
    jsonlPath,
    stderr: redact(stderr.trim(), secrets).slice(-4000),
    usage: parsed.usage,
    cwd,
  };
}

export { defaultSettingsPath, parseEventState, resolveConfig, runPi };

export default defineAction({
  title: "ANGE GameGen Pi",
  description: "使用 Anchemy 的 generate 角色配置，在 ANGE checkout 中启动真实 Pi，并加载 GameGen、subagents、todo 和 gateway 插件。默认只需提供 prompt；session、模型、thinking、目录、插件、超时和 Pi 原生额外参数可选。",
  parameters: {
    prompt: { type: "string", required: true, description: "交给 GameGen Pi 的任务描述。" },
    sessionId: { type: "string", description: "已有 Pi session UUID；省略则创建新会话。" },
    model: { type: "string", description: "覆盖 Anchemy 默认模型；不填则使用 generate 配置。" },
    thinking: { type: "string", description: "覆盖 Pi thinking 档位；不填则使用 generate 配置。" },
    name: { type: "string", description: "Pi session 显示名称。" },
    cwd: { type: "string", description: "Pi 工作目录；默认 ANGE checkout。GameGen 需要在 ANGE checkout 中运行。" },
    settingsPath: { type: "string", description: "Anchemy settings.json 路径；默认读取 AURA_ANCHEMY_SETTINGS_PATH 或系统默认路径。" },
    sessionDirectory: { type: "string", description: "session 目录；必须位于 Aura 工作目录内。" },
    outputDirectory: { type: "string", description: "JSONL 日志目录；必须位于 Aura 工作目录内。" },
    timeoutMs: { type: "integer", description: "本次 Pi 最大运行时间，1–600000 毫秒，默认 600000。" },
    plugins: { type: "array", items: { type: "string" }, description: "GameGen 角色插件子集；默认加载全部角色插件。" },
    skills: { type: "array", items: { type: "string" }, description: "额外绝对 Skill 路径；默认使用 generate 角色的 GameGen skills。" },
    extraArgs: { type: "array", items: { type: "string" }, description: "额外 Pi CLI 参数；session、模型、扩展和 JSON 模式参数由 Action 管理。" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", required: true },
        status: { type: "string", required: true },
        sessionId: { type: "string", required: true },
        sessionFile: { type: "string" },
        finalText: { type: "string", required: true },
        toolCalls: { type: "array", items: { type: "string" }, required: true },
        stopReason: { type: "string" },
        terminalError: { type: "string" },
        exitCode: { type: "integer" },
        timedOut: { type: "boolean", required: true },
        protocolComplete: { type: "boolean", required: true },
        jsonlPath: { type: "string", required: true },
        stderr: { type: "string", required: true },
        cwd: { type: "string", required: true },
        usage: { type: "object", additionalProperties: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  recovery: "manual",
  timeoutMs: 600_000,
  isConcurrencySafe: () => false,
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    const config = await resolveConfig(input);
    return runPi(ctx, config, input);
  },
});
