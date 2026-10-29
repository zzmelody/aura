import type { ChildProcess } from "node:child_process";
import type { ActionContext } from "@aura/orchestration/action";
import type { JsonValue } from "@aura/protocol/types";
import { jsonValue } from "../../src/schema.ts";

interface PiInput {
  prompt: string;
  piPath?: string;
  nodePath?: string;
  agentDirectory?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  name?: string;
  cwd?: string;
  sessionDirectory?: string;
  outputDirectory?: string;
  timeoutMs?: number;
  isolated?: boolean;
  contextFiles?: boolean;
  approveProject?: boolean;
  tools?: string[];
  excludeTools?: string[];
  extensions?: string[];
  skills?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  extraArgs?: string[];
}
type PiConfig = Awaited<ReturnType<typeof resolveConfig>>;
type PiSession =
  { mode: "create"; id: string } | { mode: "resume"; id: string; file: string };

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { defineAction } from "@aura/orchestration/action";

const OWNED_FLAGS = new Set([
  "--mode",
  "--print",
  "-p",
  "--session",
  "--session-id",
  "--session-dir",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--fork",
  "--no-session",
  "--model",
  "-m",
  "--provider",
  "--api-key",
  "--thinking",
  "--name",
  "-n",
  "--system-prompt",
  "--append-system-prompt",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--skill",
  "--no-skills",
  "--prompt-template",
  "--no-prompt-templates",
  "--theme",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--cwd",
  "--",
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const MAX_PROMPT = 200_000;
const MAX_EXTRA_ARGS = 64;
const MAX_RESOURCES = 64;

function redact(value: unknown, secrets: readonly string[]) {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join("[REDACTED]");
    try {
      output = output.split(encodeURIComponent(secret)).join("[REDACTED]");
    } catch {
      /* invalid URI bytes */
    }
  }
  return output;
}

function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i.test(
          key,
        ) &&
        typeof value === "string" &&
        value.length >= 6,
    )
    .flatMap(([, value]) => (typeof value === "string" ? [value] : []));
}

async function canonical(path: string, label: string) {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(`${label} 不可访问：${path}`, { cause: error });
  }
}

async function canonicalFile(path: string, label: string) {
  const target = await canonical(path, label);
  if (!(await stat(target)).isFile())
    throw new Error(`${label} 不是文件：${path}`);
  return target;
}

async function canonicalDirectory(path: string, label: string) {
  const target = await canonical(path, label);
  if (!(await stat(target)).isDirectory())
    throw new Error(`${label} 不是目录：${path}`);
  return target;
}

async function contained(root: string, path: string, label: string) {
  const base = await canonicalDirectory(root, `${label} 根目录`);
  const candidate = await canonical(path, label);
  const rel = relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} 超出允许目录：${path}`);
  return candidate;
}

function assertLexicallyContained(root: string, path: string, label: string) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} 超出允许目录：${path}`);
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function findExecutable(
  value: unknown,
  env = process.env,
  platform = process.platform,
) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("piPath 必须是非空字符串。");
  const requested = value.trim();
  if (isAbsolute(requested)) return canonicalFile(requested, "Pi 可执行文件");
  if (requested.includes("/") || requested.includes("\\"))
    throw new Error(
      "piPath 使用路径时必须是绝对路径；也可以提供 PATH 中的命令名。",
    );

  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffixes =
    platform === "win32"
      ? [".exe", ".com", ".js", ".mjs", ".cjs", ".ps1", ".cmd", ".bat"]
      : [""];
  const hasExtension = platform === "win32" && extname(requested);
  for (const directory of pathEntries) {
    for (const suffix of hasExtension ? [""] : suffixes) {
      const candidate = join(directory, `${requested}${suffix}`);
      if (await isFile(candidate))
        return canonicalFile(candidate, "Pi 可执行文件");
    }
  }
  throw new Error(
    `找不到 Pi 可执行文件：${requested}；请设置 piPath 或 AURA_PI_BIN。`,
  );
}

async function invocationFor(
  piPath: string,
  input: PiInput,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const extension = extname(piPath).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) {
    const nodePath = await canonicalFile(
      input.nodePath ?? envValue(env, "AURA_PI_NODE_BIN") ?? process.execPath,
      "Pi Node 可执行文件",
    );
    return { command: nodePath, prefixArgs: [piPath] };
  }
  if (extension === ".ps1") {
    if (platform !== "win32")
      throw new Error("PowerShell Pi 启动脚本只能在 Windows 上运行。");
    const powershell = envValue(env, "AURA_POWERSHELL_BIN") ?? "powershell.exe";
    return {
      command: powershell,
      prefixArgs: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        piPath,
      ],
    };
  }
  if (extension === ".cmd" || extension === ".bat")
    throw new Error(
      "为避免 shell 参数注入，piPath 不支持 .cmd/.bat；请指向 Pi 的 .js 文件、原生可执行文件或 .ps1 shim。",
    );
  return { command: piPath, prefixArgs: [] };
}

async function canonicalResources(values: unknown, label: string) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_RESOURCES)
    throw new Error(`${label} 必须是最多 ${MAX_RESOURCES} 个绝对路径。`);
  const output = [];
  for (const value of values) {
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error(`${label} 必须是绝对路径。`);
    output.push(await canonical(value, label));
  }
  return output;
}

async function resolveConfig(
  input: PiInput,
  env = process.env,
  platform = process.platform,
) {
  const piPath = await findExecutable(
    input.piPath ?? envValue(env, "AURA_PI_BIN") ?? "pi",
    env,
    platform,
  );
  const invocation = await invocationFor(piPath, input, env, platform);
  const agentDirectoryValue =
    input.agentDirectory ?? envValue(env, "AURA_PI_AGENT_DIR");
  return {
    piPath,
    ...invocation,
    agentDirectory: agentDirectoryValue
      ? await canonicalDirectory(agentDirectoryValue, "Pi agent 目录")
      : undefined,
    extensions: await canonicalResources(input.extensions, "Pi extension"),
    skills: await canonicalResources(input.skills, "Pi skill"),
  };
}

async function sessionFileFor(dir: string, sessionId: string | undefined) {
  if (!sessionId) return undefined;
  if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID。");
  const files = (await readdir(dir)).filter(
    (name) => extname(name) === ".jsonl",
  );
  const matches = [];
  for (const name of files) {
    const file = join(dir, name);
    const line = (await readFile(file, "utf8")).split("\n", 1)[0];
    try {
      const header = JSON.parse(line);
      if (header?.type === "session" && header.id === sessionId)
        matches.push(file);
    } catch {
      /* incomplete files are ignored; an exact match is still required */
    }
  }
  if (matches.length !== 1)
    throw new Error(`找不到唯一的 Pi session：${sessionId}`);
  return canonicalFile(matches[0], "Pi session");
}

function managedArg(arg: string) {
  const name = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
  if (OWNED_FLAGS.has(name)) return name;
  for (const flag of OWNED_FLAGS) {
    if (flag.startsWith("-") && !flag.startsWith("--") && arg.startsWith(flag))
      return flag;
  }
  return undefined;
}

function stringOption(value: unknown, label: string, maxLength = 2_000) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`${label} 必须是 1 到 ${maxLength} 个字符的字符串。`);
  return value;
}

function stringList(
  value: unknown,
  label: string,
  maxItems = 64,
  maxLength = 256,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== "string" || !item.trim() || item.length > maxLength,
    )
  )
    throw new Error(`${label} 必须是 1 到 ${maxItems} 个短字符串。`);
  return value as string[];
}

function buildArgs(
  config: PiConfig,
  input: PiInput,
  session: PiSession,
  sessionDir: string,
) {
  const args = ["--mode", "json", "--print"];
  const provider = stringOption(input.provider, "provider");
  const model = stringOption(input.model, "model");
  const thinking = stringOption(input.thinking, "thinking");
  const name = stringOption(input.name, "name");
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (name) args.push("--name", name);
  if (session?.mode === "resume") args.push("--session", session.file);
  else args.push("--session-id", session.id);
  args.push("--session-dir", sessionDir);

  if (input.isolated === true)
    args.push(
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    );
  if (input.contextFiles === false) args.push("--no-context-files");
  args.push(input.approveProject === true ? "--approve" : "--no-approve");

  for (const extension of config.extensions)
    args.push("--extension", extension);
  for (const skill of config.skills) args.push("--skill", skill);

  const tools = stringList(input.tools, "tools");
  const excludeTools = stringList(input.excludeTools, "excludeTools");
  if (tools) args.push("--tools", tools.join(","));
  if (excludeTools) args.push("--exclude-tools", excludeTools.join(","));
  const systemPrompt = stringOption(
    input.systemPrompt,
    "systemPrompt",
    MAX_PROMPT,
  );
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  const appendSystemPrompt = stringList(
    input.appendSystemPrompt,
    "appendSystemPrompt",
    16,
    MAX_PROMPT,
  );
  for (const value of appendSystemPrompt ?? [])
    args.push("--append-system-prompt", value);

  if (input.extraArgs !== undefined) {
    if (
      !Array.isArray(input.extraArgs) ||
      input.extraArgs.length > MAX_EXTRA_ARGS ||
      input.extraArgs.some(
        (value) =>
          typeof value !== "string" ||
          value.length > 2_000 ||
          !value.startsWith("-") ||
          value === "--",
      )
    )
      throw new Error(
        "extraArgs 必须是最多 64 个 flag；带值参数请使用 --name=value 形式。",
      );
    for (const value of input.extraArgs) {
      const owned = managedArg(value);
      if (owned)
        throw new Error(`extraArgs 不能覆盖 Pi Action 管理的参数：${value}`);
      args.push(value);
    }
  }
  args.push(input.prompt);
  return args;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const value = record(part);
      return value?.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("");
}

function parseEventState(events: readonly unknown[]) {
  let session: (Record<string, unknown> & { id: string }) | undefined;
  let finalText = "";
  let stopReason: string | undefined;
  let terminalError: string | undefined;
  let ended = false;
  const toolCalls: string[] = [];
  let usage: Record<string, JsonValue> | undefined;
  for (const value of events) {
    const event = record(value);
    if (!event) continue;
    if (event.type === "session" && !session && typeof event.id === "string")
      session = { ...event, id: event.id };
    const message = record(event.message);
    if (event.type === "message_end" && message?.role === "assistant") {
      const text = textFromContent(message.content);
      if (text.trim()) finalText = text;
      stopReason =
        typeof message.stopReason === "string" ? message.stopReason : undefined;
      if (stopReason === "error" && typeof message.errorMessage === "string")
        terminalError = message.errorMessage;
      if (Array.isArray(message.content))
        for (const entry of message.content) {
          const part = record(entry);
          if (part?.type === "toolCall" && typeof part.name === "string")
            toolCalls.push(part.name);
        }
      const reportedUsage = record(event.usage);
      if (reportedUsage)
        usage = jsonValue(reportedUsage, "Pi usage") as Record<
          string,
          JsonValue
        >;
    }
    if (event.type === "agent_end") {
      ended = true;
      if (Array.isArray(event.messages)) {
        const assistant = [...event.messages]
          .reverse()
          .map(record)
          .find((message) => message?.role === "assistant");
        if (assistant && !finalText.trim())
          finalText = textFromContent(assistant.content);
      }
    }
  }
  const protocolComplete = Boolean(session && ended && stopReason);
  const terminalStatus = !protocolComplete
    ? "incomplete"
    : stopReason === "stop" || stopReason === "toolUse"
      ? "completed"
      : "failed";
  return {
    session,
    finalText,
    stopReason,
    terminalError,
    toolCalls,
    usage,
    protocolComplete,
    terminalStatus,
  };
}

async function runPi(
  ctx: Pick<ActionContext, "cwd" | "callId" | "signal">,
  config: PiConfig,
  input: PiInput,
) {
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length === 0 ||
    input.prompt.length > MAX_PROMPT
  )
    throw new Error(`prompt 必须为 1 到 ${MAX_PROMPT} 个字符。`);

  const baseDirectory = await canonicalDirectory(ctx.cwd, "Aura 工作目录");
  const requestedCwd = resolve(baseDirectory, input.cwd ?? baseDirectory);
  const cwd = await contained(baseDirectory, requestedCwd, "Pi cwd");
  if (!(await stat(cwd)).isDirectory())
    throw new Error(`Pi cwd 不是目录：${cwd}`);

  const requestedSessionDir = resolve(
    baseDirectory,
    input.sessionDirectory ?? join(baseDirectory, ".aura", "pi", "sessions"),
  );
  assertLexicallyContained(
    baseDirectory,
    requestedSessionDir,
    "sessionDirectory",
  );
  await mkdir(requestedSessionDir, { recursive: true, mode: 0o700 });
  const sessionDir = await contained(
    baseDirectory,
    requestedSessionDir,
    "sessionDirectory",
  );
  const sessionFile = await sessionFileFor(sessionDir, input.sessionId);
  const session: PiSession = sessionFile
    ? { mode: "resume", id: input.sessionId!, file: sessionFile }
    : { mode: "create", id: input.sessionId ?? randomUUID() };

  const requestedOutputDirectory = resolve(
    baseDirectory,
    input.outputDirectory ??
      join(baseDirectory, ".aura", "pi", "runs", ctx.callId),
  );
  assertLexicallyContained(
    baseDirectory,
    requestedOutputDirectory,
    "outputDirectory",
  );
  await mkdir(requestedOutputDirectory, { recursive: true, mode: 0o700 });
  const outputRoot = await contained(
    baseDirectory,
    requestedOutputDirectory,
    "outputDirectory",
  );
  const jsonlPath = join(outputRoot, "events.jsonl");

  const args = [
    ...config.prefixArgs,
    ...buildArgs(config, input, session, sessionDir),
  ];
  const env = { ...process.env };
  if (config.agentDirectory) env.PI_CODING_AGENT_DIR = config.agentDirectory;
  const secrets = environmentSecrets(env);
  const events: Array<Record<string, unknown>> = [];
  let pending = "";
  let stderr = "";
  let timedOut = false;
  let child: ChildProcess | undefined;
  const timeoutMs = input.timeoutMs ?? 1_800_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 1_800_000
  )
    throw new Error("timeoutMs 必须为 1 到 1800000 毫秒。");

  const consume = (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push({
          ...JSON.parse(line),
          recordedAt: new Date().toISOString(),
        });
      } catch {
        stderr = `${stderr}\nPi 输出了无法解析的 JSONL。`;
      }
    }
  };
  const kill = () => {
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (!child || child.exitCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* the process may have exited between the two checks */
      }
    }, 5_000).unref();
  };

  const exitCode = await new Promise<number | null>(
    (resolvePromise, reject) => {
      try {
        child = spawn(config.command, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", consume);
      child.stderr!.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4_000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        cleanup();
        reject(new Error(`无法启动 Pi：${config.piPath}`, { cause: error }));
      });
      child.once("close", (code) => {
        cleanup();
        resolvePromise(code);
      });
    },
  );

  consume(pending + "\n");
  await writeFile(
    jsonlPath,
    events.map((event) => redact(JSON.stringify(event), secrets)).join("\n") +
      (events.length ? "\n" : ""),
    { mode: 0o600 },
  );
  if (ctx.signal.aborted) throw new Error("Pi Action 已取消。");

  const parsed = parseEventState(events);
  const ok =
    exitCode === 0 &&
    !timedOut &&
    parsed.protocolComplete &&
    parsed.terminalStatus === "completed";
  if (!ok && !parsed.finalText && parsed.terminalError)
    stderr = `${stderr}\n${parsed.terminalError}`;
  let resolvedSessionFile;
  try {
    resolvedSessionFile = await sessionFileFor(
      sessionDir,
      parsed.session?.id ?? session.id,
    );
  } catch {
    /* preserve a useful result even after an early Pi failure */
  }
  return {
    ok,
    status: timedOut ? "timeout" : ok ? "completed" : parsed.terminalStatus,
    sessionId: parsed.session?.id ?? session.id,
    sessionFile: resolvedSessionFile,
    finalText: redact(parsed.finalText, secrets),
    toolCalls: parsed.toolCalls,
    stopReason: parsed.stopReason,
    ...(parsed.terminalError
      ? { terminalError: redact(parsed.terminalError, secrets) }
      : {}),
    ...(exitCode === null ? {} : { exitCode }),
    timedOut,
    protocolComplete: parsed.protocolComplete,
    jsonlPath,
    stderr: redact(stderr.trim(), secrets).slice(-4_000),
    usage: parsed.usage,
    cwd,
  };
}

export { buildArgs, findExecutable, parseEventState, resolveConfig, runPi };

export default defineAction({
  title: "Pi",
  description:
    "在 Aura 工作区中调用本机 Pi CLI 的通用 Action。支持独立或默认资源配置、session 续接、模型、工具、extensions、skills、上下文和系统提示词；不绑定具体项目、角色或插件。",
  parameters: {
    prompt: {
      type: "string",
      required: true,
      description: "交给 Pi 的任务描述。",
    },
    piPath: {
      type: "string",
      description:
        "Pi 的绝对可执行/CLI JS 路径或 PATH 命令名；默认读取 AURA_PI_BIN，再查找 pi。",
    },
    nodePath: {
      type: "string",
      description:
        "piPath 为 JS 时使用的 Node 可执行文件；默认读取 AURA_PI_NODE_BIN 或使用 Aura 当前 Node。",
    },
    agentDirectory: {
      type: "string",
      description:
        "本次调用的 PI_CODING_AGENT_DIR；默认读取 AURA_PI_AGENT_DIR，否则沿用 Pi 默认目录。",
    },
    sessionId: {
      type: "string",
      description: "已有 Pi session UUID；省略则创建新会话。",
    },
    provider: {
      type: "string",
      description: "覆盖 Pi provider；省略则使用 Pi 配置。",
    },
    model: {
      type: "string",
      description: "覆盖 Pi 模型；省略则使用 Pi 配置。",
    },
    thinking: {
      type: "string",
      description: "覆盖 Pi thinking 档位；省略则使用 Pi 配置。",
    },
    name: { type: "string", description: "Pi session 显示名称。" },
    cwd: {
      type: "string",
      description:
        "Pi 工作目录，可相对 Aura 工作区；默认是 Aura 工作区，且不能越出工作区。",
    },
    sessionDirectory: {
      type: "string",
      description:
        "session 目录；默认 .aura/pi/sessions，且必须位于 Aura 工作区内。",
    },
    outputDirectory: {
      type: "string",
      description:
        "JSONL 日志目录；默认 .aura/pi/runs/<callId>，且必须位于 Aura 工作区内。",
    },
    timeoutMs: {
      type: "integer",
      description: "本次 Pi 最大运行时间，1–1800000 毫秒，默认 1800000。",
    },
    isolated: {
      type: "boolean",
      default: false,
      description:
        "禁用 Pi 自动发现的 extensions、skills、prompt templates 和 themes，只加载显式资源。",
    },
    contextFiles: {
      type: "boolean",
      default: true,
      description:
        "是否加载工作目录中的 AGENTS.md/CLAUDE.md 等 Pi context files。",
    },
    approveProject: {
      type: "boolean",
      default: false,
      description:
        "是否信任项目本地 Pi 配置；默认拒绝，避免非交互调用等待确认。",
    },
    tools: {
      type: "array",
      items: { type: "string" },
      description: "允许的 Pi 工具名；省略则使用 Pi 默认工具。",
    },
    excludeTools: {
      type: "array",
      items: { type: "string" },
      description: "要禁用的 Pi 工具名。",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "显式加载的本地 Pi extension 绝对路径。",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description: "显式加载的本地 Pi skill 绝对路径。",
    },
    systemPrompt: {
      type: "string",
      description: "替换 Pi 默认 system prompt。",
    },
    appendSystemPrompt: {
      type: "array",
      items: { type: "string" },
      description: "按顺序追加的 system prompt 片段。",
    },
    extraArgs: {
      type: "array",
      items: { type: "string" },
      description:
        "额外 Pi flags；带值参数用 --name=value，不能覆盖 Action 管理的参数。",
    },
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
  timeoutMs: 1800000,
  isConcurrencySafe: () => false,
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    const config = await resolveConfig(input);
    return runPi(ctx, config, input);
  },
});
