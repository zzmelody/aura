import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-token-meter";
import type {} from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-subagent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CodingCompactionResult } from "@aura/protocol/types";
import type { CodingCapabilityStore } from "./capabilities.ts";
import { redactMcpResult, type CodingIntegrations } from "./integrations.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { conversationPrompt } from "@aura/protocol/conversations";
import { chatImages, type ChatImageStore } from "../chat-images.ts";
import type { ConversationTools } from "../ports.ts";
import type { Context } from "@deepseek-ai/cordis";
import {
  buildForkSeed,
  SessionId,
  SessionLogOffset as sessionLogOffset,
  SessionSeq as sessionSeq,
  type Session,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
// Type-only: activates the approval service's `approval/request` event.
import type {} from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import {
  installModelSelection,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  CodingCollaboration,
  CodingCollaborationAction,
  CodingPermission,
  CodingSteerModelConfig,
  CodingTurnUsage,
  FlowAgentConfig,
} from "@aura/protocol/types";
import { resolveChatModel } from "../chat-models.ts";
import { agentFailure } from "@aura/dsh-auth/agent-failure";
import { CodedFlowError, FlowError } from "@aura/protocol/errors";
import type {
  CodingFileDiff,
  CodingStreamEvent,
  CodingTurn,
} from "../types.ts";
import { projectCodingEvent } from "./activity.ts";
import { codingCollaboration, isGoalIntent } from "./collaboration.ts";
import { readSessionEvents } from "./history.ts";
import { addTurnUsage, turnTokenUsage } from "./usage.ts";
import { mountWorkspaceInstructions } from "./workspace-instructions.ts";
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

/**
 * The slice of DSH's `ctx.permissionPresets` (mounted by `dsh-base`) used
 * here. Typed locally so orchestration does not depend on the package.
 */
interface PermissionPresets {
  current(session: Session): string;
  set(session: Session, name: string): void;
}

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
  images: ChatImageStore,
  tools: ConversationTools,
  isSideConversation: (id: string) => boolean,
  isWorkspaceConversation: (id: string) => boolean,
  capabilities?: CodingCapabilityStore,
  integrations?: CodingIntegrations,
) {
  const controller = ctx.sessionController;
  const collaboration = codingCollaboration(ctx);
  /** Sessions with a turn in progress in this process. */
  const active = new Set<string>();
  const goalRuns = new Set<string>();
  /** Settles when the session's in-progress turn ends, however it ends. */
  const settled = new Map<string, Promise<void>>();
  /** Agents and cancellation scopes survive navigation, not explicit closure. */
  const handles = new Map<string, AgentHandle>();
  const stops = new Map<string, AbortController>();
  /** Cancels only the in-progress turn; the conversation stays usable. */
  const turnStops = new Map<string, AbortController>();
  type SteerConfig = CodingSteerModelConfig & { defaults?: FlowAgentConfig };
  type Guide = (
    prompt: string,
    imageIds: readonly string[],
    config: SteerConfig | undefined,
    signal: AbortSignal,
    requestId: SessionRequestId,
  ) => Promise<boolean>;
  const guides = new Map<string, Guide>();

  const emitters = new Map<string, (event: CodingStreamEvent) => void>();
  const permissions = new WeakMap<Agent, () => void>();
  const childPresets = ["coding-researcher", "coding-reviewer"];
  const owned = new Set<string>();
  const maintenance = new Map<string, AbortController>();

  ctx.on("system-prompt/assemble", async (_assembly, { agent }, next) => {
    const assembled = await next();
    if (agent && goalRuns.has(agent.id)) return assembled;
    return {
      ...assembled,
      sections: assembled.sections.filter(({ name }) => name !== "tool:goal"),
    };
  });

  ctx.systemPrompt.section({
    name: "aura:side-conversation-task",
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
    text: ({ agent }) =>
      agent && isSideConversation(agent.session.id)
        ? "你在侧边会话中。使用继承的主会话历史理解项目背景、已有结论和用户的指代。以侧边会话中的用户消息确定当前任务。只有用户在侧边明确要求继续某项旧任务时，才接手该任务。围绕当前任务制定计划和调用工具。"
        : "",
  });

  ctx.on("agent/created", async ({ agent }) => {
    const { parentSession: parentId, cwd } = agent.session.header;
    const teammate =
      ctx.get("agentTeams")?.tryMembership(agent)?.role === "teammate";
    const preset = (await ctx.agentPresets.resolve("coder-v1")).id;
    const children = await Promise.all(
      childPresets.map(async (id) => (await ctx.agentPresets.resolve(id)).id),
    );
    if (agent.session.header.agentPreset === preset && !teammate) {
      owned.add(agent.id);
      if (cwd && isWorkspaceConversation(agent.id))
        mountWorkspaceInstructions(agent, cwd);
      await refreshTools(agent, false);
    } else if (
      teammate
        ? parentId && owned.has(parentId)
        : children.includes(agent.session.header.agentPreset ?? "")
    ) {
      if (!parentId || !owned.has(parentId))
        throw new CodedFlowError("子 Agent 缺少有效的父对话。", 403, {
          code: "subagent_parent_invalid",
        });
      owned.add(agent.id);
      if (
        cwd &&
        isWorkspaceConversation(parentId) &&
        ctx.agents.get(parentId)?.session.header.cwd === cwd
      )
        mountWorkspaceInstructions(agent, cwd);
      await refreshTools(agent, true);
      const nativeQuestion = agent.ctx.tools.get("ask_user_question");
      if (!nativeQuestion)
        throw new CodedFlowError("问答工具尚未就绪。", 503, {
          code: "question_tool_unavailable",
        });
      agent.ctx.tools.register({
        ...nativeQuestion,
        async execute(args, exec) {
          const parent = ctx.agents.get(parentId);
          const stop = turnStops.get(parentId)?.signal;
          if (!parent || !stop || !emitters.has(parentId))
            throw new CodedFlowError("父对话已停止。", 409, {
              code: "conversation_parent_stopped",
            });
          const input = args as { questions?: unknown };
          const items = codingQuestions(
            Array.isArray(input.questions) ? input.questions : [],
          ).map((item) => ({
            ...item,
            header: `子 Agent · ${agent.session.header.agentPreset?.includes("reviewer") ? "审查" : "调研"}`,
          }));
          // DSH deliberately accepts human interaction only on a root Agent.
          // Route the native question through its live parent, retaining the
          // child's original tool call/result and visibly attributing the ask.
          return nativeQuestion.execute(
            { ...input, questions: items },
            {
              ...exec,
              agent: parent,
              signal: AbortSignal.any([exec.signal, stop]),
            },
          );
        },
      });
    }
    return undefined;
  });
  if (capabilities) {
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      if (
        owned.has(agent.id) &&
        agent.session.header.origin !== "subagent" &&
        capabilities.config().autoCompact
      ) {
        try {
          await ctx.compaction.compactIfNeeded(agent, "pressure", signal);
        } catch {
          signal.throwIfAborted();
          // Match the native automatic policy: a failed reduction does not
          // discard the turn or automatically resend the summary request.
          emitters.get(agent.id)?.({
            type: "notice",
            id: `compact-warning-${Date.now()}`,
            text: "自动压缩未完全降低上下文占用，本轮将继续。可在本轮结束后检查额度或拆分输入。",
            at: Date.now(),
          });
        }
      }
      return next();
    });
    ctx.on("llm/stream", (options, next) => {
      const agent = options.sessionId
        ? ctx.agents.get(options.sessionId)
        : undefined;
      const kind =
        options.purpose === "compaction"
          ? "compaction"
          : agent?.session.header.origin === "subagent"
            ? "subagent"
            : options.sessionId && goalRuns.has(options.sessionId)
              ? "goal"
              : undefined;
      if (!kind || !options.sessionId || !owned.has(options.sessionId))
        return next();
      const sessionId = options.sessionId;
      return (async function* () {
        options.signal?.throwIfAborted();
        if (
          agent &&
          ctx.agentTeams.tryMembership(agent)?.role === "teammate" &&
          !integrations?.enabled("agentTeam")
        )
          throw new CodedFlowError("Agent 团队已停用。", 409, {
            code: "agent_team_disabled",
          });
        const id = await capabilities
          .reserve(kind, sessionId)
          .catch((error: unknown) => {
            if (kind === "goal" && error instanceof FlowError)
              emitters.get(sessionId)?.({
                type: "notice",
                id: `goal-budget-${randomUUID()}`,
                text: error.message,
                at: Date.now(),
              });
            throw error;
          });
        let complete = options.signal?.aborted === true;
        try {
          options.signal?.throwIfAborted();
          for await (const chunk of next()) {
            if (chunk.type === "finish")
              complete =
                chunk.reason.kind !== "error" &&
                chunk.reason.kind !== "aborted";
            yield chunk;
          }
        } finally {
          await capabilities.settle(id, complete);
        }
      })();
    });
    ctx.on("tools/execute", async (exec, next) => {
      if (integrations?.teamTool(exec.name, exec.agent?.id)) {
        if (
          !exec.agent ||
          !owned.has(exec.agent.id) ||
          !integrations.enabled("agentTeam")
        )
          throw new CodedFlowError("当前对话未启用 Agent 团队。", 409, {
            code: "agent_team_disabled",
          });
      }
      if (exec.name.startsWith("mcp__")) {
        const agent = exec.agent;
        if (
          !agent ||
          !owned.has(agent.id) ||
          agent.session.header.origin === "subagent" ||
          !integrations?.mcpTools().includes(exec.name)
        )
          throw new CodedFlowError("当前对话未启用此 MCP 工具。", 403, {
            code: "mcp_tool_disabled",
          });
        if (!canUseMcp(agent))
          throw new CodedFlowError(
            "只读权限或计划模式下无法执行外部 MCP 工具。",
            403,
            { code: "mcp_permission_denied" },
          );
        exec.signal.throwIfAborted();
        const secrets = integrations.mcpSecrets();
        const reservation = await capabilities.reserve("mcp", agent.id);
        let complete = false;
        try {
          const result = redactMcpResult(await next(), secrets);
          complete = !result.isError;
          return result;
        } catch {
          throw new CodedFlowError("MCP 工具调用未完成。", 502, {
            code: "mcp_tool_failed",
          });
        } finally {
          await capabilities.settle(reservation, complete);
        }
      }
      if (!exec.agent || !owned.has(exec.agent.id)) return next();
      if (
        (exec.name === "get_goal" || exec.name === "update_goal") &&
        !goalRuns.has(exec.agent.id)
      )
        throw new CodedFlowError("请先从输入框启动或继续目标。", 409, {
          code: "goal_input_required",
        });
      if (exec.name === "subagent") {
        if (
          !capabilities.config().subagents ||
          integrations?.enabled("agentTeam")
        )
          throw new CodedFlowError("子 Agent 已停用。", 409, {
            code: "subagent_disabled",
          });
        // Every child model request reserves from the user's ledger; refuse
        // the spawn up front instead of starting a child that cannot run.
        capabilities.assertBudgetAvailable();
        const args = exec.arguments as { cwd?: unknown };
        if (
          args.cwd !== undefined &&
          (typeof args.cwd !== "string" ||
            resolve(exec.agent.session.header.cwd ?? "", args.cwd) !==
              exec.agent.session.header.cwd)
        )
          throw new CodedFlowError("子 Agent 必须继承父对话目录。", 403, {
            code: "subagent_directory_mismatch",
          });
      }
      if (exec.name !== "web_search" && exec.name !== "web_fetch")
        return next();
      const state = await capabilities.snapshot();
      if (!state.web || !state.hasWebKey)
        throw new CodedFlowError("请先配置 DeepSeek Web 服务。", 409, {
          code: "web_configuration_required",
        });
      exec.signal.throwIfAborted();
      const id = await capabilities.reserve("web", exec.agent.id);
      let complete = false;
      try {
        const result = await next();
        complete = !result.isError;
        return result;
      } finally {
        await capabilities.settle(id, complete);
      }
    });
  }

  /**
   * Switches a conversation's DSH permission preset (sandbox mode + approval
   * policy) through `ctx.permissionPresets`, the same write path as DSH's
   * `/permission` command. The knobs are session events, so the switch survives
   * restart and reaches the model through the runtime-context snapshot; a
   * running turn picks it up on its next confined call. Without a loaded
   * session the saved choice is applied when the next turn starts.
   */
  function applyPermission(sessionId: string, permission: CodingPermission) {
    const presets = ctx.get("permissionPresets") as
      PermissionPresets | undefined;
    if (!presets)
      throw new CodedFlowError("DSH 对话权限服务不可用。", 503, {
        code: "permissions_unavailable",
      });
    const id = SessionId(sessionId);
    const session = ctx.agents.get(id)?.session ?? ctx.sessions.get(id);
    if (!session || presets.current(session) === permission) return;
    presets.set(session, permission);
  }

  function canUseMcp(agent: Agent) {
    const presets = ctx.get("permissionPresets") as
      PermissionPresets | undefined;
    return (
      !!presets &&
      presets.current(agent.session) !== "read-only" &&
      !collaboration.current(agent).planning
    );
  }

  async function refreshTools(agent: Agent, child: boolean) {
    await integrations?.ready();
    const previous = permissions.get(agent);
    const state = await capabilities?.snapshot();
    const base = child
      ? ["read", "glob", "grep", "ask_user_question", "send_message"]
      : [
          ...codingTools,
          ...(goalRuns.has(agent.id) ? ["get_goal", "update_goal"] : []),
        ];
    const extra = [
      ...(state?.web && state.hasWebKey ? ["web_search", "web_fetch"] : []),
      ...(!child && state?.subagents && !integrations?.enabled("agentTeam")
        ? ["subagent", "send_message", "interrupt_agent", "list_agents"]
        : []),
      ...(!child && integrations?.enabled("mcp") && canUseMcp(agent)
        ? integrations.mcpTools()
        : []),
    ];
    if (!permissions.has(agent)) agent.ctx.tools.presentAs("native");
    const missing = base.filter((name) => !agent.ctx.tools.get(name));
    if (missing.length)
      throw new CodedFlowError(`对话工具未注册：${missing.join("、")}。`, 400, {
        code: "conversation_tools_missing",
        params: { tools: missing },
      });
    const shell = child
      ? undefined
      : shellTools.find((name) => agent.ctx.tools.get(name));
    permissions.set(
      agent,
      agent.ctx.tools.restrict({
        allow: [...base, ...extra, ...(shell ? [shell] : [])],
      }),
    );
    previous?.();
  }

  async function existingAgent(
    id: string,
    signal: AbortSignal,
  ): Promise<Agent | undefined> {
    const sessionId = SessionId(id);
    const live = ctx.agents.get(sessionId);
    if (live) return live;
    if (!(await readSessionEvents(controller, sessionId, signal, 1))) return;
    const preset = (await ctx.agentPresets.resolve("coder-v1")).id;
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      signal,
      setup: async (scope) => {
        await ctx.agentPresets.mount(scope, preset);
      },
    });
    handles.set(id, handle);
    return handle.agent;
  }

  async function collaborationState(
    id: string,
    signal: AbortSignal,
  ): Promise<CodingCollaboration> {
    const sessionId = SessionId(id);
    const agent = ctx.agents.get(sessionId);
    return agent
      ? collaboration.current(agent)
      : collaboration.stored(sessionId, signal);
  }

  async function changeCollaboration(
    id: string,
    action: CodingCollaborationAction,
  ): Promise<CodingCollaboration> {
    if (active.has(id) || maintenance.has(id))
      throw new CodedFlowError("请先等待本轮结束或停止生成。", 409, {
        code: "conversation_turn_busy",
      });
    const abort = new AbortController();
    maintenance.set(id, abort);
    try {
      const signal = AbortSignal.any([
        abort.signal,
        sessionStop(id).signal,
        AbortSignal.timeout(30_000),
      ]);
      const agent = await existingAgent(id, signal);
      signal.throwIfAborted();
      if (!agent)
        throw new CodedFlowError("请在发送首条消息时选择协作模式。", 409, {
          code: "collaboration_initial_required",
        });
      if (agent.status === "running")
        throw new CodedFlowError("请先等待本轮结束或停止生成。", 409, {
          code: "conversation_turn_busy",
        });
      collaboration.change(agent, action);
      await ctx.sessions.flush(agent.session);
      return collaboration.current(agent);
    } finally {
      maintenance.delete(id);
    }
  }

  async function compact(id: string): Promise<CodingCompactionResult> {
    if (active.has(id) || maintenance.has(id))
      throw new CodedFlowError("请先等待本轮结束或停止生成。", 409, {
        code: "conversation_turn_busy",
      });
    const abort = new AbortController();
    maintenance.set(id, abort);
    try {
      const agent = await existingAgent(
        id,
        AbortSignal.any([abort.signal, sessionStop(id).signal]),
      );
      if (!agent)
        return { compacted: false, replacedMessages: 0, previousTokens: 0 };
      const beforeTokens = ctx.tokenMeter.measure(agent.session).surfaceTokens;
      let result: CodingCompactionResult = {
        compacted: false,
        replacedMessages: 0,
        previousTokens: 0,
      };
      const unsubscribe = ctx.on("session/event", (session, event) => {
        if (session.id === id && event.type === "compaction/summary")
          result = {
            compacted: true,
            replacedMessages: event.data.shadowedSeqs.length,
            previousTokens: event.data.shadowedTokenCount,
          };
      });
      try {
        const command = await ctx.commands.execute(
          agent,
          "/compact",
          [],
          AbortSignal.any([
            abort.signal,
            sessionStop(id).signal,
            AbortSignal.timeout(5 * 60_000),
          ]),
        );
        if (!command || command.result.kind === "error")
          throw new CodedFlowError(
            "压缩未完成；请检查额外请求额度和会话状态，结果未知时不要直接重试。",
            409,
            { code: "compaction_incomplete" },
          );
        await ctx.sessions.flush(agent.session);
        return {
          ...result,
          savedTokens: Math.max(
            0,
            beforeTokens - ctx.tokenMeter.measure(agent.session).surfaceTokens,
          ),
        };
      } finally {
        unsubscribe();
      }
    } finally {
      maintenance.delete(id);
    }
  }

  return {
    stream,
    compact,
    stop: stopTurn,
    steer: steerTurn,
    close: closeSession,
    closeSide: closeSession,
    applyPermission,
    collaborationState,
    changeCollaboration,
    /** Whether a turn of this conversation is running right now. */
    running: (sessionId: string) => active.has(sessionId),
  };

  /**
   * Stops the running turn of one conversation, independent of whether the
   * client's stream disconnect reached us, and waits until it has settled.
   */
  async function stopTurn(sessionId: string): Promise<boolean> {
    const pending = maintenance.get(sessionId);
    if (pending) {
      pending.abort();
      return true;
    }
    const turn = turnStops.get(sessionId);
    if (!turn) return false;
    const agent =
      goalRuns.has(sessionId) && ctx.agents.get(SessionId(sessionId));
    if (agent) collaboration.pause(agent);
    turn.abort(
      new CodedFlowError("已停止生成。", 400, { code: "generation_stopped" }),
    );
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
    config?: SteerConfig,
    requestId: string = randomUUID(),
  ): Promise<boolean> {
    const turn = turnStops.get(sessionId);
    if (!turn || !active.has(sessionId)) return false;
    // Bound to the turn being steered: steering can never outlive it.
    const stop = AbortSignal.any([
      turn.signal,
      sessionStop(sessionId).signal,
      AbortSignal.timeout(CODING_STEER_TIMEOUT_MS),
    ]);
    const guide = guides.get(sessionId);
    if (!guide) return false;
    try {
      return await guide(
        prompt,
        imageIds,
        config,
        stop,
        requestId as SessionRequestId,
      );
    } catch (error) {
      // A turn that stops during admission never receives the guidance.
      if (turn.signal.aborted && error === turn.signal.reason) return false;
      throw error;
    }
  }

  /** Admit content through DSH without changing the deployment's default model. */
  async function submitPrompt(
    request: {
      sessionId: ReturnType<typeof SessionId>;
      requestId: SessionRequestId;
      mode: "steer" | "queue";
      content: Array<
        | { type: "text"; text: string }
        | Awaited<ReturnType<typeof promptImages>>[number]
      >;
    },
    signal: AbortSignal,
    config: Awaited<ReturnType<typeof resolveChatModel>>,
    commit?: () => void,
  ): Promise<boolean> {
    const agent = ctx.agents.get(request.sessionId);
    if (!agent)
      throw new CodedFlowError("对话已结束，请重新发送。", 409, {
        code: "conversation_ended",
      });
    if (request.content.some((part) => part.type === "image")) {
      const info = await ctx.llm.resolveModelInfo(
        config.provider,
        config.model,
        signal,
      );
      if (info.inputModalities && !info.inputModalities.includes("image"))
        throw new CodedFlowError(
          "当前模型不支持图片输入，请更换支持图片的模型，或移除附件后重新发送。",
          422,
          { code: "model_images_unsupported" },
        );
    }
    const content = await ctx.attachments.admitPromptContent(request.content);
    signal.throwIfAborted();
    const message = createUserMessage({
      content,
      source: { kind: "user", rpcId: request.requestId },
    });
    if (request.mode === "steer" && agent.status !== "running") return false;
    commit?.();
    if (request.mode === "steer") agent.steer(message);
    else agent.followup(message);
    return true;
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
    permission: () => CodingPermission | undefined,
  ): Promise<{ model: string }> {
    if (active.has(turn.sessionId) || maintenance.has(turn.sessionId))
      throw new CodedFlowError(
        "这段对话还有一轮在进行，请先等它结束或停止。",
        409,
        { code: "conversation_turn_busy" },
      );
    if (isGoalIntent(turn.intent)) {
      if (turn.images?.length)
        throw new CodedFlowError(
          "目标指令需要纯文本。请先在普通消息中发送参考图片。",
          400,
          { code: "goal_text_required" },
        );
      if (!capabilities)
        throw new CodedFlowError("对话额度账本不可用。", 503, {
          code: "budget_service_unavailable",
        });
      capabilities.assertBudgetAvailable();
      goalRuns.add(turn.sessionId);
    }
    active.add(turn.sessionId);
    emitters.set(turn.sessionId, emit);
    const own = new AbortController();
    turnStops.set(turn.sessionId, own);
    const turnDone = run(
      turn,
      emit,
      AbortSignal.any([signal, own.signal]),
      permission,
    );
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
      // In-flight guidance must never spill into a later turn of this agent.
      own.abort(
        new CodedFlowError("这一轮已经结束了，请重新发送。", 409, {
          code: "conversation_ended",
        }),
      );
      active.delete(turn.sessionId);
      goalRuns.delete(turn.sessionId);
      emitters.delete(turn.sessionId);
      settled.delete(turn.sessionId);
      if (turnStops.get(turn.sessionId) === own)
        turnStops.delete(turn.sessionId);
    }
  }

  /** Stops and releases a conversation; durable history remains DSH-owned. */
  async function closeSession(sessionId: string): Promise<boolean> {
    const existed = stops.has(sessionId) || handles.has(sessionId);
    const stop = sessionStop(sessionId);
    stop.abort(
      new CodedFlowError("对话已关闭。", 400, { code: "conversation_closed" }),
    );
    await settled.get(sessionId);
    const handle = handles.get(sessionId);
    handles.delete(sessionId);
    // Keep the aborted scope so an already-dispatched request cannot revive it.
    const session = ctx.sessions.get(SessionId(sessionId));
    if (session) await ctx.sessions.flush(session).catch(() => false);
    if (handle) await ctx.subagents.drainDescendants([handle.agent]);
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

  /** Seeds an agent through the selected completed turn or the usual side-chat cut. */
  async function forkAgent(
    parentId: string,
    options: {
      sessionId: SessionId;
      cwd: string;
      preset: string;
      agentOptions: { provider: string; model: string };
      setup: (agentCtx: Context) => Promise<void>;
      signal: AbortSignal;
      endSeq?: number;
    },
  ): Promise<AgentHandle> {
    const parent = await controller
      .inspect(SessionId(parentId), options.signal)
      .catch(() => {
        throw new CodedFlowError("来源对话没有可用的分叉记录。", 404, {
          code: "fork_source_unavailable",
        });
      });
    const boundary = options.endSeq ?? forkBoundary(parent.events);
    if (
      options.endSeq !== undefined &&
      !parent.events.some(
        (event) =>
          event.seq === options.endSeq &&
          event.type === "turn/end" &&
          event.data.reason.kind === "completed",
      )
    )
      throw new CodedFlowError("找不到可以分叉的已完成轮次。", 409, {
        code: "fork_turn_unavailable",
      });
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
    permission: () => CodingPermission | undefined,
  ): Promise<{ model: string }> {
    const cwd = codingCwd(turn.project);
    const goalIntent = isGoalIntent(turn.intent) ? turn.intent : undefined;
    const stop = AbortSignal.any([
      signal,
      AbortSignal.timeout(CODING_TURN_TIMEOUT_MS),
      sessionStop(turn.sessionId).signal,
    ]);
    let config = await resolveChatModel(
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
    if (goalIntent && !live && !stored && turn.history?.length)
      throw new CodedFlowError(
        "请先发送一条普通消息导入旧对话，再启动目标。",
        409,
        { code: "legacy_import_required" },
      );
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
              endSeq: turn.branchAt,
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
      if (!stored && turn.forkFrom) collaboration.change(agent, "clear-goal");
      // A new side task starts outside any plan mode inherited from its parent.
      if (!stored && turn.forkFrom && isSideConversation(turn.sessionId)) {
        const planMode = ctx.get("planMode") as
          { set(agent: Agent, active: boolean): void } | undefined;
        planMode?.set(agent, false);
      }
    }
    await refreshTools(agent, false);
    // Session setup can await I/O while a permission change is being saved.
    const presetPermission = permission();
    if (presetPermission) applyPermission(turn.sessionId, presetPermission);
    const scoped: Array<() => void> = [];
    const disposers: Array<() => void> = [];
    let goalStarted = false;
    try {
      // Snapshot route, reasoning and token limits together at prompt assembly.
      const selection: ModelSelectionRef = {
        current: config,
        assembled: undefined,
      };
      scoped.push(installModelSelection(agent.ctx, selection));
      let assembledConfig = config;
      scoped.push(
        agent.ctx.on(
          "system-prompt/assemble",
          async (_assembly, _context, next) => {
            const captured = config;
            const assembled = await next();
            assembledConfig = captured;
            return assembled;
          },
        ),
      );
      scoped.push(
        agent.ctx.on("agent/request", async (_payload, next) => {
          const resolved = await next();
          const { maxTokens: _inheritedMaxTokens, ...rest } = resolved;
          return {
            ...rest,
            ...(assembledConfig.maxTokens === undefined
              ? {}
              : { maxTokens: assembledConfig.maxTokens }),
          };
        }),
      );
      // Serialize guidance so a slower validation cannot overwrite a later choice.
      let guiding: Promise<unknown> = Promise.resolve();
      const guide: Guide = (prompt, imageIds, requested, signal, requestId) => {
        const admission = guiding.then(async () => {
          signal.throwIfAborted();
          if (!active.has(turn.sessionId) || agent.status !== "running")
            return false;
          if (requested && requested.mode !== turn.mode)
            throw new CodedFlowError(
              "请在当前模型服务内选择模型；本轮结束后可切换服务。",
              409,
              { code: "model_service_change_forbidden" },
            );
          const nextConfig = requested
            ? await resolveChatModel(
                ctx.llm,
                requested.mode,
                requested.selection,
                signal,
                requested.defaults,
              )
            : config;
          const content = [
            {
              type: "text" as const,
              text: prompt.trim() || "请查看我附上的图片。",
            },
            ...(await promptImages(imageIds, signal)),
          ];
          // Prompt admission and the model change commit synchronously after validation.
          return submitPrompt(
            {
              sessionId,
              requestId,
              mode: "steer",
              content,
            },
            signal,
            nextConfig,
            () => {
              agent.session.append("model/selection", {
                provider: nextConfig.provider,
                model: nextConfig.model,
                ...(nextConfig.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: nextConfig.reasoningEffort }),
              });
              config = nextConfig;
              selection.current = nextConfig;
            },
          );
        });
        guiding = admission.catch(() => {});
        return admission;
      };
      guides.set(turn.sessionId, guide);
      // Record the pending choice without changing the deployment default.
      agent.session.append("model/selection", {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      });
      for (const tool of tools({
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
          if (!items.length)
            throw new CodedFlowError("模型发起了空的问题。", 400, {
              code: "model_question_empty",
            });
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
      const requestId = (turn.requestId ?? randomUUID()) as SessionRequestId;
      let turnNumber: number | undefined;
      let matched: number | undefined;
      let endSeq: number | undefined;
      let nativeTurn: SessionEvent[] | undefined;
      let usage: CodingTurnUsage | undefined;
      let incompleteUsage = false;
      let wroteText = false;
      let followupFailure: Error | undefined;
      let finish!: { resolve(): void; reject(reason: unknown): void };
      const completed = new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
      });
      completed.catch(() => {});
      let finishGoal!: { resolve(): void; reject(reason: unknown): void };
      const goalFinished = new Promise<void>((resolve, reject) => {
        finishGoal = { resolve, reject };
      });
      goalFinished.catch(() => {});
      const reportCollaboration = () => {
        const state = collaboration.current(agent);
        emit({ type: "collaboration", state });
        if (goalStarted && !state.goal?.armed) finishGoal.resolve();
      };
      if (goalIntent)
        disposers.push(
          ctx.on("goal/activation-changed", ({ sessionId: changed }) => {
            if (changed === sessionId) reportCollaboration();
          }),
        );
      // New-file content from `write` calls, keyed by call id until the
      // result arrives (DSH attaches no hunks for a file that did not exist).
      const created = new Map<string, CodingFileDiff>();
      // This request's own prompt, told apart from the steering the user sends
      // while the turn runs: both are user messages inside the same turn, and
      // only the latter belongs in the transcript as its own entry. Parked
      // steering is consumed before our opening prompt when a stopped turn
      // continues; it must still confirm the original submission by rpcId.
      const ownPrompt = (message: Record<string, unknown>) =>
        (message.source as { rpcId?: unknown } | undefined)?.rpcId ===
        requestId;
      disposers.push(
        ctx.on("session/event", (session, event) => {
          if (session.id !== sessionId) return;
          if (["plan/mode", "goal/change"].includes(event.type))
            reportCollaboration();
          if (event.type === "turn/start") {
            nativeTurn = [];
            emit({
              type: "turn-start",
              turnId: `turn-${event.seq}`,
              at: event.time,
            });
          }
          nativeTurn?.push(event);
          const ended = event.type === "turn/end" ? nativeTurn : undefined;
          if (event.type === "turn/end") nativeTurn = undefined;
          projectCodingEvent(event, emit, created, ownPrompt);
          if (event.type === "turn/start") turnNumber = event.data.turn;
          if (
            event.type === "user/message" &&
            (goalIntent
              ? String(event.data.source.kind) === "goal"
              : "rpcId" in event.data.source &&
                event.data.source.rpcId === requestId)
          ) {
            matched ??= turnNumber;
            if (goalIntent) reportCollaboration();
          }
          if (matched === undefined) return;
          if (
            event.type === "turn/end" &&
            event.data.turn >= matched &&
            event.data.reason.kind === "completed"
          ) {
            endSeq = event.seq;
            if (!incompleteUsage) {
              const next = ended && turnTokenUsage(ended);
              usage = next && (usage ? addTurnUsage(usage, next) : next);
              incompleteUsage = usage === undefined;
            }
          }
          if (
            event.type === "assistant/message" &&
            event.data.turn >= matched &&
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
          if (
            event.type === "turn/end" &&
            event.data.turn > matched &&
            event.data.reason.kind !== "completed"
          )
            followupFailure = agentFailure();
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
      let childrenStopping: Promise<void> | undefined;
      const onAbort = () => {
        finishGoal.reject(stop.reason);
        if (goalStarted) collaboration.pause(agent);
        controller.cancel({ sessionId });
        childrenStopping = ctx.subagents
          .listChildren(sessionId)
          .then((children) =>
            ctx.subagents.drainChildren(
              agent,
              children.map((child) => child.id),
            ),
          );
        // Joined below; observe immediately so a fast teardown error is contained.
        void childrenStopping.catch(() => undefined);
        finish.reject(stop.reason);
      };
      stop.addEventListener("abort", onAbort, { once: true });
      try {
        stop.throwIfAborted();
        if (goalIntent) {
          collaboration.startGoal(agent, goalIntent, turn.prompt);
          goalStarted = true;
          reportCollaboration();
          // DSH may be briefly idle while it checkpoints between goal rounds.
          // Keep the interaction and accounting scopes until continuation ends.
          await Promise.race([
            goalFinished,
            completed.then(() => goalFinished),
          ]);
        } else {
          if (turn.intent === "plan" || turn.intent === "execute")
            collaboration.change(agent, turn.intent);
          reportCollaboration();
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
            config,
          );
          await completed;
        }
        await agent.whenIdle();
        while (await ctx.subagents.waitForChildren(agent))
          await agent.whenIdle();
        await agent.whenIdle();
        stop.throwIfAborted();
        if (goalIntent && matched === undefined)
          throw new CodedFlowError(
            "目标未能开始续跑，请检查目标状态和请求额度。",
            409,
            { code: "goal_start_failed" },
          );
        if (followupFailure) throw followupFailure;
        if (usage) emit({ type: "usage", usage });
        if (endSeq !== undefined) emit({ type: "turn-boundary", endSeq });
      } finally {
        stop.removeEventListener("abort", onAbort);
        if (stop.aborted) controller.cancel({ sessionId });
        await childrenStopping;
      }
      return { model: config.model };
    } finally {
      try {
        if (goalStarted) {
          collaboration.disarm(agent);
          emit({ type: "collaboration", state: collaboration.current(agent) });
        }
        // An errored parent must not leave charged child work running after
        // its question/approval bridge has been removed. Completed children
        // remain in DSH's catalog and can be explicitly continued later.
        await ctx.subagents.drainChildren(
          agent,
          (await ctx.subagents.listChildren(sessionId)).map(
            (child) => child.id,
          ),
        );
      } finally {
        guides.delete(turn.sessionId);
        for (const dispose of disposers) dispose();
        for (const dispose of scoped.reverse()) dispose();
        const session = ctx.sessions.get(sessionId);
        if (session) await ctx.sessions.flush(session).catch(() => false);
        // The agent stays registered so the next turn resumes this session.
      }
    }
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
    throw new CodedFlowError("请先选择一个项目目录。", 400, {
      code: "workspace_directory_required",
    });
  if (!isAbsolutePath(project))
    throw new CodedFlowError("项目目录必须是绝对路径。", 400, {
      code: "workspace_directory_absolute",
    });
  return resolve(project);
}

function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/u.test(value);
}
