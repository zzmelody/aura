import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { conversationPrompt } from "@aura/protocol/conversations";
import { chatImages } from "../chat-images.ts";
import { chatTools, type ChatToolHost } from "../chat-tools.ts";
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
  "skill",
  // DSH Schedule reminders: due occurrences arrive as follow-ups in this
  // session, so the agent itself drives them under the same allow-list.
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_delete",
] as const;

/** Shell tool names differ by platform; whichever exists is admitted. */
const shellTools = ["bash", "pwsh"] as const;

const CODING_TURN_TIMEOUT_MS = 30 * 60_000;
/**
 * Upper bound on one steering admission. Steering only has to reach the
 * running agent's inbox, so it never waits out the turn it is steering.
 */
const CODING_STEER_TIMEOUT_MS = 30_000;

export interface CodingSessionKey {
  /** Aura-owned coding session id; one DSH session per project conversation. */
  id: string;
  /** Absolute project directory the sandbox confines writes to. */
  cwd: string;
}

/**
 * The shared conversation driver: a persistent DSH session bound to a
 * directory. Todo, plan mode and tool history accumulate across turns;
 * the JSONL log remains readable after navigation and host restart.
 */
export function codingService(
  ctx: Context,
  questions: CodingQuestions,
  images: Pick<GeneratedArtifacts, "readImage">,
  workflows: ChatToolHost,
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

  // The allow-list belongs to the agent, not to a turn: DSH Schedule delivers
  // reminders straight into a live or restored agent, outside `run()`, and
  // that turn must see exactly the tools a user-sent turn sees.
  ctx.on("agent/created", async ({ agent }) => {
    const preset = (await ctx.agentPresets.resolve("coder-v1")).id;
    if (agent.session.header.agentPreset === preset) mountCodingTools(agent);
    return undefined;
  });

  return {
    stream,
    stop: stopTurn,
    steer: steerTurn,
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

  /**
   * Steers the running turn: the text joins the turn DSH is already running,
   * which consumes it at its next step boundary, so the model changes course
   * without losing the work it has done. The turn's own events keep streaming
   * on the request that started it, which is why this resolves as soon as the
   * agent accepted the message rather than waiting for the reply.
   *
   * Only a conversation with a turn running in this process can be steered,
   * so another DSH session (for example a Flow agent) cannot be reached
   * through its id, and a finished conversation reports `false` instead of
   * silently starting a turn nobody is streaming.
   */
  async function steerTurn(
    sessionId: string,
    prompt: string,
    imageIds: readonly string[] = [],
  ): Promise<boolean> {
    const turn = turnStops.get(sessionId);
    if (!turn || !active.has(sessionId)) return false;
    // Bound to the turn being steered: steering can never outlive it.
    const stop = AbortSignal.any([
      turn.signal,
      sessionStop(sessionId).signal,
      AbortSignal.timeout(CODING_STEER_TIMEOUT_MS),
    ]);
    const content = [
      { type: "text" as const, text: prompt.trim() || "请查看我附上的图片。" },
      ...(await promptImages(imageIds, stop)),
    ];
    await submitPrompt(
      {
        sessionId: SessionId(sessionId),
        requestId: randomUUID() as SessionRequestId,
        mode: "steer",
        content,
      },
      stop,
    );
    return true;
  }

  /** Preserve DSH's safe admission reason without forwarding provider errors. */
  async function submitPrompt(
    request: Parameters<typeof controller.prompt>[0],
    signal: AbortSignal,
  ) {
    try {
      return await controller.prompt(request, signal);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "details" in error &&
        (error.details as { reason?: unknown } | undefined)?.reason ===
          "MODEL_DOES_NOT_SUPPORT_IMAGES"
      )
        throw new FlowError(
          "当前模型不支持图片输入，请更换支持图片的模型，或移除附件后重新发送。",
          422,
        );
      throw error;
    }
  }

  /**
   * Uploaded images as prompt content. They are re-read by content ID, so a
   * client can only reference pictures it uploaded, never arbitrary paths.
   */
  async function promptImages(
    imageIds: readonly string[],
    signal: AbortSignal,
  ) {
    const pictures = [];
    for (const [index, id] of imageIds.entries()) {
      const image = await images.readImage(id, signal);
      pictures.push({
        type: "image" as const,
        mediaType: image.mediaType,
        data: image.bytes.toString("base64"),
        name: `图${index + 1}`,
      });
    }
    return pictures;
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
      // Reused agents must apply this turn's selection to every model request.
      scoped.push(
        agent.ctx.on("agent/request", async (_payload, next) => {
          await next();
          return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: config.reasoningEffort }),
            ...(config.maxTokens === undefined
              ? {}
              : { maxTokens: config.maxTokens }),
          };
        }),
      );
      // Record the pending choice without changing the deployment default.
      agent.session.append("model/selection", {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      });
      for (const tool of chatTools(workflows, {
        mode: turn.mode,
        sessionId: turn.sessionId,
        signal: stop,
        started: (run) => emit({ type: "workflow", ...run }),
      }))
        scoped.push(agent.ctx.tools.register(tool));
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
      // This request's own prompt, told apart from the steering the user sends
      // while the turn runs: both are user messages inside the same turn, and
      // only the latter belongs in the transcript as its own entry. A message
      // seen before ours has no turn of this request to belong to either.
      const ownPrompt = (message: Record<string, unknown>) =>
        matched === undefined ||
        (message.source as { rpcId?: unknown } | undefined)?.rpcId ===
          requestId;
      disposers.push(
        ctx.on("session/event", (session, event) => {
          if (session.id !== sessionId) return;
          projectCodingEvent(event, emit, created, ownPrompt);
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
        const imported =
          !live && !stored && !turn.forkFrom && turn.history?.length
            ? await chatImages(
                {
                  mode: turn.mode,
                  messages: [
                    ...turn.history,
                    { role: "user", text: turn.prompt, images: turn.images },
                  ],
                },
                images,
                stop,
              )
            : undefined;
        const pictures =
          imported?.parts ?? (await promptImages(turn.images ?? [], stop));
        await submitPrompt(
          {
            sessionId,
            requestId,
            mode: "queue",
            content: [
              // DSH needs a text part; an image-only request gets a short cue.
              {
                type: "text",
                text: conversationPrompt(
                  turn.prompt.trim() || "请查看我附上的图片。",
                  imported?.history.slice(0, -1),
                  turn.context,
                ),
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
   * names and nothing else the profile mounts reaches the model. Both
   * registrations unwind with the agent's scope.
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
    agent.ctx.tools.presentAs("native");
    // A coding session needs every listed tool; the shell name varies by
    // platform, so only one of those is expected to exist.
    const available = codingTools.filter((name) => agent.ctx.tools.get(name));
    const missing = codingTools.filter((name) => !available.includes(name));
    if (missing.length)
      throw new FlowError(`编码工具未注册：${missing.join("、")}。`);
    const shell = shellTools.find((name) => agent.ctx.tools.get(name));
    agent.ctx.tools.restrict({
      allow: [...available, ...(shell ? [shell] : [])],
    });
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
