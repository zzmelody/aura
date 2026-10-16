import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  buildForkSeed,
  SessionId,
  SessionLogOffset as sessionLogOffset,
  SessionSeq as sessionSeq,
} from "@deepseek-ai/dsh-session";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
// Type-only: activates the approval service's `approval/request` event.
import type {} from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import { resolveChatModel } from "../chat-models.ts";
import { agentFailure } from "../sessions.ts";
import { FlowError } from "../schema.ts";
import type {
  CodingFileDiff,
  CodingStreamEvent,
  CodingTurn,
} from "../types.ts";
import type { GeneratedArtifacts } from "../artifacts/generated.ts";
import { projectCodingEvent } from "./activity.ts";
import { readSessionEvents } from "./history.ts";
import {
  approvalOutcome,
  approvalQuestion,
  codingQuestions,
  type CodingQuestions,
} from "./questions.ts";

/**
 * Tools a coding agent may use. Re-admitting a name here is the only way it
 * reaches the model: the profile mounts DSH's coding plugins, and this
 * allow-list decides which of them a coding session actually sees. Every
 * name must be registered, or the turn fails rather than run short a tool.
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
  "ask_user_question",
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
export function codingService(
  ctx: Context,
  questions: CodingQuestions,
  images: Pick<GeneratedArtifacts, "readImage">,
) {
  const controller = ctx.sessionController;
  /** Sessions with a turn in progress in this process. */
  const active = new Set<string>();
  /** Settles when the session's in-progress turn ends, however it ends. */
  const settled = new Map<string, Promise<void>>();
  /** Agents and cancellation scopes survive navigation, not explicit closure. */
  const handles = new Map<string, AgentHandle>();
  const stops = new Map<string, AbortController>();
  /** Cancels only the in-progress turn; the conversation stays usable. */
  const turnStops = new Map<string, AbortController>();

  return {
    stream,
    stop: stopTurn,
    close: closeSession,
    closeSide: closeSession,
    /** Whether a turn of this conversation is running right now. */
    running: (sessionId: string) => active.has(sessionId),
  };

  /**
   * Stops the running turn of one conversation, independent of whether the
   * client's stream disconnect reached us, and waits until it has settled.
   */
  async function stopTurn(sessionId: string): Promise<boolean> {
    const turn = turnStops.get(sessionId);
    if (!turn) return false;
    turn.abort(new FlowError("已停止生成。"));
    await settled.get(sessionId);
    return true;
  }

  async function stream(
    turn: CodingTurn,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    if (active.has(turn.sessionId))
      throw new FlowError("这段对话还有一轮在进行，请先等它结束或停止。", 409);
    active.add(turn.sessionId);
    const own = new AbortController();
    turnStops.set(turn.sessionId, own);
    const turnDone = run(turn, emit, AbortSignal.any([signal, own.signal]));
    settled.set(
      turn.sessionId,
      turnDone.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await turnDone;
    } finally {
      active.delete(turn.sessionId);
      settled.delete(turn.sessionId);
      if (turnStops.get(turn.sessionId) === own)
        turnStops.delete(turn.sessionId);
    }
  }

  /** Stops and releases a conversation; durable history remains DSH-owned. */
  async function closeSession(sessionId: string): Promise<boolean> {
    const existed = stops.has(sessionId) || handles.has(sessionId);
    const stop = sessionStop(sessionId);
    stop.abort(new FlowError("对话已关闭。"));
    await settled.get(sessionId);
    const handle = handles.get(sessionId);
    handles.delete(sessionId);
    // Keep the aborted scope so an already-dispatched request cannot revive it.
    const session = ctx.sessions.get(SessionId(sessionId));
    if (session) await ctx.sessions.flush(session).catch(() => false);
    await handle?.dispose();
    return existed;
  }

  function sessionStop(sessionId: string): AbortController {
    let stop = stops.get(sessionId);
    if (!stop) {
      stop = new AbortController();
      stops.set(sessionId, stop);
    }
    return stop;
  }

  /**
   * Creates a side chat's agent from its parent's log, cut at the parent's
   * latest completed turn so a turn still running there is not half-copied.
   * A parent with no completed turn yet is cut at its last event; DSH closes
   * that open tail with synthetic results that tell the model the parent may
   * have finished those calls. The child keeps the parent's directory, so
   * the sandbox boundary is unchanged.
   */
  async function forkAgent(
    parentId: string,
    options: {
      sessionId: SessionId;
      cwd: string;
      preset: string;
      agentOptions: { provider: string; model: string };
      setup: (agentCtx: Context) => Promise<void>;
      signal: AbortSignal;
    },
  ): Promise<AgentHandle> {
    const parent = await controller
      .inspect(SessionId(parentId), options.signal)
      .catch(() => {
        throw new FlowError("主对话还没有记录，暂时不能开旁支。", 404);
      });
    const boundary = forkBoundary(parent.events);
    return ctx.agents.create({
      sessionId: options.sessionId,
      agentOptions: options.agentOptions,
      meta: {
        agentPreset: options.preset,
        cwd: options.cwd,
        ...(boundary === undefined
          ? {}
          : { parentSession: SessionId(parentId), isSeeded: true }),
      },
      ...(boundary === undefined
        ? {}
        : {
            seed: buildForkSeed(parent.events, sessionSeq(boundary)),
            inheritedEventCount: sessionLogOffset(boundary + 1),
          }),
      signal: options.signal,
      setup: options.setup,
    });
  }

  async function run(
    turn: CodingTurn,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    const cwd = codingCwd(turn.project);
    const stop = AbortSignal.any([
      signal,
      AbortSignal.timeout(CODING_TURN_TIMEOUT_MS),
      sessionStop(turn.sessionId).signal,
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
    const agentOptions = { provider: config.provider, model: config.model };
    const setup = async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, preset);
    };
    // A live agent means a later turn of an existing conversation: reuse it so
    // the todo list, plan mode and tool history carry over. A conversation
    // whose agent is gone (the host restarted) resumes from its stored log, so
    // the model keeps its context instead of starting over.
    // A side chat's first turn forks its parent instead of starting empty.
    const live = ctx.agents.get(sessionId);
    const stored =
      !live &&
      (await readSessionEvents(controller, sessionId, stop, 1)) !== undefined;
    let agent = live;
    if (!agent) {
      const handle = stored
        ? await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            signal: stop,
            setup,
          })
        : turn.forkFrom
          ? await forkAgent(turn.forkFrom, {
              sessionId,
              cwd,
              preset,
              agentOptions,
              setup,
              signal: stop,
            })
          : await ctx.agents.create({
              sessionId,
              agentOptions,
              // The session header cwd is immutable and becomes the sandbox's
              // workspace-write boundary, so every mutation stays in the project.
              meta: { agentPreset: preset, cwd },
              signal: stop,
              setup,
            });
      handles.set(turn.sessionId, handle);
      agent = handle.agent;
    }
    const scoped: Array<() => void> = [];
    const disposers: Array<() => void> = [];
    try {
      // Scoped restrictions are lifted when this turn ends, so every turn,
      // including follow-ups on a live agent, re-applies the allow-list.
      scoped.push(...mountCodingTools(agent));
      // Answer this agent's `ask_user_question` calls through the client:
      // the question goes out on the turn stream and the call waits until
      // the user answers or the turn stops. Agent-scoped, so it never claims
      // a question from another session.
      scoped.push(
        agent.ctx.on("user-questions/request", async (request) => {
          const items = codingQuestions(request.questions);
          if (!items.length) throw new FlowError("模型发起了空的问题。");
          const asked = request.signal
            ? AbortSignal.any([stop, request.signal])
            : stop;
          const answers = await questions.ask(
            turn.sessionId,
            items,
            asked,
            (questionId) =>
              emit({ type: "question", questionId, questions: items }),
          );
          return { answers } satisfies AskUserQuestionAnswer;
        }),
      );
      // Approvals (for example a command retried outside the sandbox) reach
      // the user as a grant-once-or-refuse card. Stopping the turn rejects the
      // wait, which DSH turns into the fail-closed `unavailable` outcome.
      scoped.push(
        agent.ctx.on("approval/request", async (request) => {
          const item = approvalQuestion(request.toolName, request.reason);
          const asked = request.signal
            ? AbortSignal.any([stop, request.signal])
            : stop;
          const answers = await questions.ask(
            turn.sessionId,
            [item],
            asked,
            (questionId) =>
              emit({ type: "question", questionId, questions: [item] }),
          );
          return approvalOutcome(answers);
        }),
      );
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
          projectCodingEvent(event, emit, created);
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
        // Uploaded images are re-read by content ID, so a client can only
        // reference pictures it uploaded, never arbitrary paths.
        const pictures = [];
        for (const [index, id] of (turn.images ?? []).entries()) {
          const image = await images.readImage(id, stop);
          pictures.push({
            type: "image" as const,
            mediaType: image.mediaType,
            data: image.bytes.toString("base64"),
            name: `图${index + 1}`,
          });
        }
        await controller.prompt(
          {
            sessionId,
            requestId,
            mode: "queue",
            content: [
              // DSH needs a text part; an image-only request gets a short cue.
              {
                type: "text",
                text: turn.prompt.trim() || "请查看我附上的图片。",
              },
              ...pictures,
            ],
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
  }

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

type AgentHandle = Awaited<ReturnType<Context["agents"]["create"]>>;

/**
 * The inclusive seq a side chat inherits through: the end of the latest
 * completed turn, including standalone events before the next turn starts
 * (the rule DSH's own session fork uses). Without a completed turn it is the
 * last event, and an empty log has none.
 */
export function forkBoundary(
  events: ReadonlyArray<{ seq: number; type: string; surfaceOp?: unknown }>,
): number | undefined {
  const end = events.findLast((event) => event.type === "turn/end");
  if (!end) return events.at(-1)?.seq;
  let boundary = end.seq;
  for (const next of events.slice(end.seq + 1)) {
    if (
      next.type === "turn/start" ||
      (next.type === "user/message" && next.surfaceOp === "append") ||
      next.type === "agent/inbox/spliced"
    )
      break;
    boundary = next.seq;
  }
  return boundary;
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
