import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
import { resolveChatModel } from "../chat-models.ts";
import { agentFailure } from "../sessions.ts";
import { FlowError } from "../schema.ts";
import type {
  CodingFileDiff,
  CodingStreamEvent,
  CodingTurn,
} from "../types.ts";

/**
 * Tools a coding agent may use. Re-admitting a name here is the only way it
 * reaches the model: the profile mounts DSH's coding plugins, and this
 * allow-list decides which of them a coding session actually sees.
 *
 * `ask_user_question` is deliberately absent until Aura answers the question
 * seam: DSH fails such a call closed with no answerer, so exposing it now would
 * only give the model a tool that always errors. `read_image` registers only
 * with an attachment store, so a missing name is dropped rather than failing.
 */
export const codingTools = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "present",
  "exit_plan_mode",
] as const;

/** Shell tool names differ by platform; whichever exists is admitted. */
const shellTools = ["bash", "pwsh"] as const;

const CODING_TURN_TIMEOUT_MS = 30 * 60_000;

export interface CodingSessionKey {
  /** Aura-owned coding session id; one DSH session per project conversation. */
  id: string;
  /** Absolute project directory the sandbox confines writes to. */
  cwd: string;
}

/**
 * One coding conversation: a persistent DSH session bound to a project
 * directory. Unlike the one-shot chat path, the session outlives a single
 * turn so the todo list, plan mode, and tool history accumulate across
 * follow-up requests, and the JSONL log stays readable afterwards.
 */
export function codingService(ctx: Context) {
  const controller = ctx.sessionController;

  return async function stream(
    turn: CodingTurn,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    const cwd = codingCwd(turn.project);
    const stop = AbortSignal.any([
      signal,
      AbortSignal.timeout(CODING_TURN_TIMEOUT_MS),
    ]);
    const config = await resolveChatModel(
      ctx.llm,
      turn.mode,
      {
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.reasoningEffort
          ? { reasoningEffort: turn.reasoningEffort }
          : {}),
      },
      stop,
      turn.defaults,
    );
    const sessionId = SessionId(turn.sessionId);
    const preset = (await ctx.agentPresets.resolve("coder-v1")).id;
    // A live agent means a later turn of an existing conversation: reuse it so
    // the todo list, plan mode and tool history carry over.
    const existing = ctx.agents.get(sessionId);
    const agent =
      existing ??
      (
        await ctx.agents.create({
          sessionId,
          agentOptions: { provider: config.provider, model: config.model },
          // The session header cwd is immutable and becomes the sandbox's
          // workspace-write boundary, so every mutation stays in the project.
          meta: { agentPreset: preset, cwd },
          signal: stop,
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset);
          },
        })
      ).agent;
    const scoped: Array<() => void> = [];
    const disposers: Array<() => void> = [];
    try {
      // Scoped restrictions are lifted when this turn ends, so every turn,
      // including follow-ups on a live agent, re-applies the allow-list.
      scoped.push(...mountCodingTools(agent));
      const requestId = randomUUID() as SessionRequestId;
      let turnNumber: number | undefined;
      let matched: number | undefined;
      let wroteText = false;
      let finish!: { resolve(): void; reject(reason: unknown): void };
      const completed = new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
      });
      completed.catch(() => {});
      // New-file content from `write` calls, keyed by call id until the
      // result arrives (DSH attaches no hunks for a file that did not exist).
      const created = new Map<string, CodingFileDiff>();
      disposers.push(
        ctx.on("session/event", (session, event) => {
          if (session.id !== sessionId) return;
          emitCodingEvent(event, emit, created);
          if (event.type === "turn/start") turnNumber = event.data.turn;
          if (
            event.type === "user/message" &&
            "rpcId" in event.data.source &&
            event.data.source.rpcId === requestId
          )
            matched = turnNumber;
          if (matched === undefined) return;
          if (
            event.type === "assistant/message" &&
            event.data.turn === matched &&
            !event.data.interrupted
          ) {
            const text = event.data.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            if (text) {
              emit({ type: "delta", text: wroteText ? `\n\n${text}` : text });
              wroteText = true;
            }
          }
          if (event.type === "turn/end" && event.data.turn === matched) {
            if (event.data.reason.kind === "completed") finish.resolve();
            else
              finish.reject(
                agentFailure(
                  event.data.reason.kind === "error"
                    ? event.data.reason.error.message
                    : undefined,
                ),
              );
          }
        }),
      );
      disposers.push(
        ctx.on("api-session/error", (id, message) => {
          if (id === sessionId) finish.reject(agentFailure(message));
        }),
      );
      const onAbort = () => {
        controller.cancel({ sessionId });
        finish.reject(stop.reason);
      };
      stop.addEventListener("abort", onAbort, { once: true });
      try {
        stop.throwIfAborted();
        await controller.prompt(
          {
            sessionId,
            requestId,
            mode: "queue",
            content: [{ type: "text", text: turn.prompt }],
          },
          stop,
        );
        await completed;
        await ctx.agents.get(sessionId)?.whenIdle();
      } finally {
        stop.removeEventListener("abort", onAbort);
        if (stop.aborted) controller.cancel({ sessionId });
      }
      return { model: config.model };
    } finally {
      for (const dispose of disposers) dispose();
      for (const dispose of scoped.reverse()) dispose();
      const session = ctx.sessions.get(sessionId);
      if (session) await ctx.sessions.flush(session).catch(() => false);
      // The agent stays registered so the next turn resumes this session.
    }
  };

  /**
   * Admits the coding tool set to this agent's own scope. DSH restrictions
   * filter inherited tools only, so `restrict({ allow })` keeps exactly these
   * names and nothing else the profile mounts reaches the model.
   */
  function mountCodingTools(agent: {
    ctx: {
      tools: {
        presentAs(mode: "native"): () => void;
        restrict(filter: { allow: readonly string[] }): () => void;
        get(name: string): unknown;
      };
    };
  }) {
    const mounted: Array<() => void> = [];
    mounted.push(agent.ctx.tools.presentAs("native"));
    // A coding session needs every listed tool; the shell name varies by
    // platform, so only one of those is expected to exist.
    const available = codingTools.filter((name) => agent.ctx.tools.get(name));
    const missing = codingTools.filter((name) => !available.includes(name));
    if (missing.length)
      throw new FlowError(`编码工具未注册：${missing.join("、")}。`);
    const shell = shellTools.find((name) => agent.ctx.tools.get(name));
    mounted.push(
      agent.ctx.tools.restrict({
        allow: [...available, ...(shell ? [shell] : [])],
      }),
    );
    return mounted;
  }
}

/** Validates the project directory and returns the absolute session cwd. */
export function codingCwd(project: string): string {
  if (typeof project !== "string" || !project.trim())
    throw new FlowError("请先选择一个项目目录。", 400);
  if (!isAbsolutePath(project))
    throw new FlowError("项目目录必须是绝对路径。", 400);
  return resolve(project);
}

function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/u.test(value);
}

/** Projects DSH session events into the coding activity stream. */
function emitCodingEvent(
  event: { type: string } & Record<string, unknown>,
  emit: (event: CodingStreamEvent) => void,
  created: Map<string, CodingFileDiff>,
) {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return;
  const fields = data as Record<string, unknown>;
  if (event.type === "tool/call") {
    const { callId, name } = fields;
    if (typeof callId === "string" && typeof name === "string") {
      const detail = toolDetail(fields.arguments);
      if (name === "write") {
        const diff = createdFile(fields.arguments);
        if (diff) created.set(callId, diff);
      }
      emit({
        type: "tool",
        phase: "start",
        callId,
        name,
        ...(detail ? { detail } : {}),
      });
    }
  }
  if (event.type === "tool/result") {
    // The call id and failure flag live on the single tool-result block, not
    // on the event itself.
    const message = fields.message as { content?: unknown } | undefined;
    const block = Array.isArray(message?.content)
      ? (message.content[0] as { toolCallId?: unknown; isError?: unknown })
      : undefined;
    if (typeof block?.toolCallId === "string") {
      const pending = created.get(block.toolCallId);
      created.delete(block.toolCallId);
      let diffs = resultDiffs(fields.meta);
      if (!diffs.length && pending && block.isError !== true) diffs = [pending];
      emit({
        type: "tool",
        phase: "end",
        callId: block.toolCallId,
        ok: block.isError !== true,
        ...(diffs.length ? { diffs } : {}),
      });
    }
  }
  if (event.type === "todo/write") {
    const todos = Array.isArray(fields.todos) ? fields.todos : [];
    const done = todos.filter(
      (todo) =>
        typeof todo === "object" &&
        todo !== null &&
        (todo as { status?: unknown }).status === "completed",
    ).length;
    emit({ type: "progress", done, total: todos.length });
  }
  if (event.type === "deliverables/presented") {
    const files = Array.isArray(fields.files) ? fields.files : [];
    for (const file of files) {
      const path = (file as { path?: unknown } | null)?.path;
      if (typeof path === "string") emit({ type: "deliverable", path });
    }
  }
}

/**
 * The one argument that says what a tool call touches — a file, a command or a
 * search pattern — so the transcript can show it. `arguments` is the model's
 * raw JSON; anything unparsable simply yields no detail.
 */
function toolDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof args !== "object" || args === null) return undefined;
  const fields = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim())
      return value.replace(/\s+/gu, " ").trim().slice(0, 160);
  }
  return undefined;
}

/** Hunks per result and characters per side kept for the change card. */
const DIFF_HUNKS = 12;
const DIFF_TEXT = 4_000;

/**
 * The applied hunks `dsh-tool-fs` attaches to a write or edit result as
 * `{ diffs: [{ path, oldText, newText }] }`. The shape is tool-private, so
 * anything unexpected yields no card rather than an error; each side is
 * clipped so a large rewrite cannot flood the stream.
 */
function resultDiffs(meta: unknown): CodingFileDiff[] {
  const diffs = (meta as { diffs?: unknown } | null | undefined)?.diffs;
  if (!Array.isArray(diffs)) return [];
  const result: CodingFileDiff[] = [];
  for (const item of diffs.slice(0, DIFF_HUNKS)) {
    const diff = item as Partial<Record<keyof CodingFileDiff, unknown>> | null;
    if (
      typeof diff?.path !== "string" ||
      typeof diff.newText !== "string" ||
      (diff.oldText !== null && typeof diff.oldText !== "string")
    )
      continue;
    result.push({
      path: diff.path,
      oldText:
        typeof diff.oldText === "string"
          ? diff.oldText.slice(0, DIFF_TEXT)
          : null,
      newText: diff.newText.slice(0, DIFF_TEXT),
    });
  }
  return result;
}

/**
 * `write` attaches hunks only when the file already existed; for a new file
 * its card shows the written content as added, as DSH's own card does. The
 * call's arguments are the only place that content appears.
 */
function createdFile(raw: unknown): CodingFileDiff | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const args = JSON.parse(raw) as { file_path?: unknown; content?: unknown };
    return typeof args.file_path === "string" &&
      typeof args.content === "string"
      ? {
          path: args.file_path,
          oldText: null,
          newText: args.content.slice(0, DIFF_TEXT),
        }
      : undefined;
  } catch {
    return undefined;
  }
}
