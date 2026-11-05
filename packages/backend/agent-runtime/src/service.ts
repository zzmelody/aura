import { codingSubagents } from "./conversations/subagents.ts";
import {
  CodingIntegrations,
  integrationsDomain,
  MAX_VOICE_BYTES,
} from "./conversations/integrations.ts";
import {
  CodingCapabilityStore,
  capabilitiesDomain,
  type CapabilityRecord,
} from "./conversations/capabilities.ts";
import { pluginMarket } from "./plugin-market.ts";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import {
  CODING_COLLABORATION_ACTIONS,
  CODING_RUN_INTENTS,
  isCodingSteerRequestId,
} from "@aura/protocol";
import { randomUUID } from "node:crypto";
import { ConversationExecutions } from "./conversations/conversation-executions.ts";
import {
  conversationCommandsDomain,
  parseConversationCommand,
  type ConversationCommandRecord,
} from "./conversations/conversation-commands.ts";
import type { CodingHistoryPage } from "@aura/protocol/types";
import { isConversationCursor } from "@aura/protocol/conversation-channel";
import { codingService } from "./conversations/session.ts";
import { isGoalIntent } from "./conversations/collaboration.ts";
import { conversationService } from "./conversations/conversations.ts";
import { conversationTitleGenerator } from "./conversations/conversation-title.ts";
import { automationService } from "./conversations/automation.ts";
import {
  conversationSides,
  legacyConversationTurns,
} from "@aura/protocol/conversations";
import {
  sessionHistoryTurns,
  lastTurnStatus,
  readSessionEvents,
  readSessionEventPage,
} from "./conversations/history.ts";
import {
  CodingConversationIndex,
  codingDomainSpec,
  codingPermissionSchema,
  conversationMessageSchema,
  conversationModelSchema,
  type CodingConversationRecord,
} from "./conversations/index-record.ts";
import { conversationList } from "./conversations/conversation-list.ts";
import { codingSkills } from "./conversations/skills.ts";
import { CodingQuestions } from "./conversations/questions.ts";
import { chatModelCatalog, RejectedChatModels } from "./chat-models.ts";
import { FlowError } from "@aura/protocol/errors";
import {
  CHAT_IMAGE_LIMIT,
  type FlowAgentConfig,
  type FlowMode,
} from "@aura/protocol/types";
import type { ChatImageStore } from "./chat-images.ts";
import type { ConversationTools, ConversationWorkspaces } from "./ports.ts";
import type { Table } from "./types.ts";

const chatModeSchema = z.enum(["demo", "codex", "lumina", "custom"]);

interface AgentServiceOptions {
  workspaces: ConversationWorkspaces;
  images: ChatImageStore;
  tools: ConversationTools;
  resolveModeDefaults(mode: FlowMode): Promise<FlowAgentConfig>;
  measureStorage<T>(work: () => Promise<T>): Promise<T>;
  notify(method: string, params: Record<string, unknown>): void;
}

export async function createAgentService(
  ctx: Context,
  options: AgentServiceOptions,
) {
  const {
    workspaces: codingProjects,
    images,
    tools,
    resolveModeDefaults,
    measureStorage,
    notify,
  } = options;
  // Coding projects ride on DSH's workspace registry; only conversation
  // titles need Aura's own index, since a session header carries none.
  const codingDomain = await measureStorage(() =>
    ctx.storageDomain.open(codingDomainSpec),
  );
  const codingConversations = new CodingConversationIndex(
    codingDomain.table(
      "conversations",
    ) as unknown as Table<CodingConversationRecord>,
  );
  const chats = new Map<string, AbortController>();
  const rejectedChatModels = new RejectedChatModels();
  const codingAnswers = new CodingQuestions();
  const capabilityDomain = await ctx.storageDomain.open(capabilitiesDomain);
  const capabilities = new CodingCapabilityStore(
    capabilityDomain.table("settings") as unknown as Table<CapabilityRecord>,
    ctx.credentials,
  );
  const integrationDomain = await ctx.storageDomain.open(integrationsDomain);
  const integrations = new CodingIntegrations(
    ctx,
    integrationDomain.table("settings"),
    codingConversations,
    process.env.DSH_HOME ?? process.cwd(),
    process.env.AURA_LOCAL_INTEGRATIONS === "1",
  );
  integrations.start();
  const coding = codingService(
    ctx,
    codingAnswers,
    images,
    tools,
    (id) =>
      id.startsWith("side-") && Boolean(codingConversations.sideParent(id)),
    (id) =>
      Boolean(
        codingConversations.get(id) ?? codingConversations.sideParent(id),
      ),
    capabilities,
    integrations,
  );
  const conversations = conversationService(
    codingProjects,
    codingConversations,
    coding,
    conversationTitleGenerator(ctx.llm, capabilities),
  );
  const commandDomain = await ctx.storageDomain.open(
    conversationCommandsDomain,
  );
  const executions = new ConversationExecutions(
    commandDomain.table(
      "commands",
    ) as unknown as Table<ConversationCommandRecord>,
    {
      assertSession(id) {
        if (!codingConversations.get(id) && !codingConversations.sideParent(id))
          throw new FlowError("对话不存在或已移除。", 404);
      },
      async start(sessionId, command, emit, signal) {
        const { modelConfig, ...input } = command.input;
        signal.throwIfAborted();
        const defaults = await resolveModeDefaults(input.mode);
        signal.throwIfAborted();
        return conversations.stream(
          {
            ...input,
            ...modelConfig,
            sessionId,
            requestId: command.commandId,
            defaults,
          },
          emit,
          signal,
        );
      },
      async control(sessionId, command) {
        if (command.type === "turn.steer") {
          const defaults = command.modelConfig
            ? await resolveModeDefaults(command.modelConfig.mode)
            : undefined;
          if (executions.execution(sessionId)?.id !== command.executionId)
            throw new FlowError("目标执行已经结束。", 409);
          const steered = await coding.steer(
            sessionId,
            command.prompt,
            command.images ?? [],
            command.modelConfig
              ? { ...command.modelConfig, defaults }
              : undefined,
            command.commandId,
          );
          if (!steered)
            throw new FlowError("目标执行已经停止接收追加消息。", 409);
          if (command.modelConfig)
            await conversations.selectModel(
              sessionId,
              command.modelConfig.mode,
              command.modelConfig.selection,
            );
        } else if (command.type === "question.answer") {
          await request("coding/answer", {
            sessionId,
            questionId: command.questionId,
            answers: command.answers,
          });
        }
      },
      async history(sessionId) {
        return (await request("coding/history", { sessionId, page: true }))!
          .data as CodingHistoryPage;
      },
    },
  );
  const automation = automationService(ctx, codingConversations);

  return { request, notification, close: () => executions.close() };

  function notification(method: string, params: Record<string, unknown>) {
    if (method === "chat/cancel" && typeof params.chatId === "string")
      chats.get(params.chatId)?.abort(new Error("客户端已取消对话。"));
    if (method === "integrations/voice/cancel" && typeof params.id === "string")
      integrations.cancelRecording(params.id);
  }

  async function request(method: string, params: Record<string, unknown>) {
    const id = typeof params.id === "string" ? params.id : "";
    let data: unknown;
    switch (method) {
      case "coding/commands": {
        if (
          typeof params.sessionId !== "string" ||
          !params.sessionId ||
          params.sessionId.length > 200
        )
          throw new FlowError("无效的对话。", 400);
        data = await executions.submit(
          params.sessionId,
          parseConversationCommand(params.command),
        );
        break;
      }
      case "coding/commands/read": {
        if (
          typeof params.sessionId !== "string" ||
          typeof params.commandId !== "string"
        )
          throw new FlowError("无效的命令查询。", 400);
        data = executions.receipt(params.sessionId, params.commandId);
        break;
      }
      case "coding/snapshot": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的对话。", 400);
        data = await executions.snapshot(params.sessionId);
        break;
      }
      case "coding/events": {
        if (
          typeof params.sessionId !== "string" ||
          (params.cursor !== undefined && !isConversationCursor(params.cursor))
        )
          throw new FlowError("无效的事件游标。", 400);
        executions.assertReadable(params.sessionId);
        data = executions.events.read(
          params.sessionId,
          params.cursor as string | undefined,
        );
        break;
      }
      case "integrations/settings":
        data = integrations.snapshot();
        break;
      case "integrations/flags":
        data = integrations.flags();
        break;
      case "integrations/save":
        data = await integrations.update(params);
        break;
      case "integrations/voice/prepare":
        await integrations.prepareVoice(params.cancel === true);
        data = integrations.snapshot();
        break;
      case "integrations/voice/transcribe": {
        const input = z
          .object({
            id: z.uuid(),
            audio: z.base64().max(Math.ceil(MAX_VOICE_BYTES / 3) * 4),
          })
          .safeParse(params);
        if (!input.success) throw new FlowError("录音格式无效。", 400);
        data = await integrations.transcribe(input.data.id, input.data.audio);
        break;
      }
      case "integrations/search": {
        const input = z
          .object({
            projectId: z.string().min(1),
            query: z.string().trim().min(1).max(256),
          })
          .safeParse(params);
        if (!input.success) throw new FlowError("请输入有效的搜索词。", 400);
        data = await integrations.search(
          input.data.projectId,
          input.data.query,
        );
        break;
      }
      case "integrations/team":
        data = await integrations.teamView(id);
        break;
      case "integrations/market":
        if (!integrations.enabled("market"))
          throw new FlowError("插件市场未启用。", 409);
        data = await pluginMarket(
          typeof params.query === "string"
            ? params.query.trim().slice(0, 256)
            : "",
        );
        break;
      case "chat/models": {
        const mode = chatModeSchema.safeParse(params.mode);
        if (!mode.success) throw new FlowError("无效的对话模式。", 400);
        data = await chatModelCatalog(
          ctx.llm,
          mode.data,
          AbortSignal.timeout(15_000),
          rejectedChatModels,
          await resolveModeDefaults(mode.data),
        );
        break;
      }
      case "chat": {
        const chatId = typeof params.chatId === "string" ? params.chatId : "";
        const turn = z
          .object({
            sessionId: z.string().trim().min(1).max(200).optional(),
            messages: z
              .array(
                z.object({
                  role: z.enum(["user", "assistant"]),
                  text: z.string().max(80_000),
                  images: z
                    .array(z.string().regex(/^[a-f0-9]{64}$/u))
                    .max(4)
                    .optional(),
                }),
              )
              .min(1)
              .max(200),
            mode: chatModeSchema,
            model: z.string().trim().min(1).max(200).optional(),
            reasoningEffort: z.string().trim().min(1).max(80).optional(),
          })
          .safeParse(params);
        if (!chatId || chatId.length > 200 || !turn.success)
          throw new FlowError("无效的对话请求。", 400);
        const abort = new AbortController();
        chats.set(chatId, abort);
        try {
          const last = turn.data.messages.at(-1)!;
          if (last.role !== "user")
            throw new FlowError("对话需要以用户消息结束。", 400);
          data = await executions.stream(
            turn.data.sessionId ?? `chat-${randomUUID()}`,
            {
              commandId: randomUUID(),
              type: "turn.start",
              input: {
                prompt: last.text,
                images: last.images,
                history: turn.data.messages.slice(0, -1),
                mode: turn.data.mode,
                modelConfig: {
                  ...(turn.data.model ? { model: turn.data.model } : {}),
                  ...(turn.data.reasoningEffort
                    ? { reasoningEffort: turn.data.reasoningEffort }
                    : {}),
                },
              },
            },
            (event) => {
              if (event.type === "delta" || event.type === "workflow")
                notify("chat/event", { chatId, event });
            },
            abort.signal,
          );
        } catch (error) {
          // agentFailure names the model when the subscription refuses it.
          const refused =
            error instanceof FlowError
              ? error.message.match(/^模型 (\S+) 不支持 Codex 订阅账号/u)?.[1]
              : undefined;
          if (refused && turn.data.mode === "codex")
            rejectedChatModels.reject("codex", refused);
          throw error;
        } finally {
          chats.delete(chatId);
        }
        break;
      }
      case "coding": {
        const chatId = typeof params.chatId === "string" ? params.chatId : "";
        const turn = z
          .object({
            sessionId: z.string().trim().min(1).max(200),
            projectId: z.string().trim().min(1).max(200).optional(),
            prompt: z.string().max(80_000),
            images: z
              .array(z.string().regex(/^[a-f0-9]{64}$/u))
              .max(CHAT_IMAGE_LIMIT)
              .optional(),
            forkFrom: z.string().trim().min(1).max(200).optional(),
            branchFrom: z.string().trim().min(1).max(200).optional(),
            branchAt: z.number().int().nonnegative().optional(),
            history: z.array(conversationMessageSchema).max(200).optional(),
            context: z.string().max(40_000).optional(),
            mode: chatModeSchema,
            model: z.string().trim().min(1).max(200).optional(),
            reasoningEffort: z.string().trim().min(1).max(80).optional(),
            permission: codingPermissionSchema.optional(),
            intent: z.enum(CODING_RUN_INTENTS).optional(),
          })
          .safeParse(params);
        if (
          !chatId ||
          chatId.length > 200 ||
          !turn.success ||
          // An image-only request is fine; an empty one is not.
          (!turn.data.prompt.trim() && !turn.data.images?.length) ||
          (isGoalIntent(turn.data.intent) && !!turn.data.images?.length)
        )
          throw new FlowError("无效的编码请求。", 400);
        const abort = new AbortController();
        chats.set(chatId, abort);
        try {
          const { sessionId, model, reasoningEffort, ...input } = turn.data;
          data = await executions.stream(
            sessionId,
            {
              commandId: randomUUID(),
              type: "turn.start",
              input: {
                ...input,
                modelConfig: {
                  ...(model ? { model } : {}),
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                },
              },
            },
            (event) => notify("chat/event", { chatId, event }),
            abort.signal,
          );
        } finally {
          chats.delete(chatId);
        }
        break;
      }
      case "coding/capabilities":
        data = await capabilities.snapshot();
        break;
      case "coding/capabilities/save":
        data = await capabilities.save(params);
        break;
      case "coding/agents":
      case "coding/agents/stop": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的对话。", 400);
        const parent =
          codingConversations.get(params.sessionId) ??
          codingConversations.sideParent(params.sessionId);
        if (!parent || parent.archivedAt !== undefined)
          throw new FlowError("对话不存在或已归档。", 404);
        if (method === "coding/agents/stop") {
          if (typeof params.childId !== "string")
            throw new FlowError("无效的子 Agent。", 400);
          data = ctx.subagents.interruptByParent(
            SessionId(params.childId),
            SessionId(params.sessionId),
            "continuable",
          );
        } else data = await codingSubagents(ctx, params.sessionId);
        break;
      }
      case "coding/compact": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的对话。", 400);
        const parent =
          codingConversations.get(params.sessionId) ??
          codingConversations.sideParent(params.sessionId);
        if (!parent || parent.archivedAt !== undefined)
          throw new FlowError("对话不存在或已归档。", 404);
        data = await coding.compact(params.sessionId);
        break;
      }
      case "coding/collaboration": {
        const request = z
          .object({
            sessionId: z.string().min(1).max(200),
            action: z.enum(CODING_COLLABORATION_ACTIONS).optional(),
          })
          .strict()
          .safeParse(params);
        if (!request.success) throw new FlowError("无效的协作模式请求。", 400);
        const { sessionId, action } = request.data;
        const parent =
          codingConversations.get(sessionId) ??
          codingConversations.sideParent(sessionId);
        if (!parent || (action && parent.archivedAt !== undefined))
          throw new FlowError("对话不存在或已归档。", 404);
        data = action
          ? await coding.changeCollaboration(sessionId, action)
          : await coding.collaborationState(
              sessionId,
              AbortSignal.timeout(30_000),
            );
        break;
      }
      case "coding/stop": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的对话。", 400);
        // Only coding turns are registered here, so another DSH session
        // (for example a Flow agent) cannot be stopped by its id.
        data = {
          stopped:
            (await executions.stop(params.sessionId)) ||
            (await coding.stop(params.sessionId)),
        };
        break;
      }
      case "coding/steer": {
        const steer = z
          .object({
            sessionId: z.string().trim().min(1).max(200),
            prompt: z.string().max(80_000),
            requestId: z.custom<string>(isCodingSteerRequestId).optional(),
            images: z
              .array(z.string().regex(/^[a-f0-9]{64}$/u))
              .max(CHAT_IMAGE_LIMIT)
              .optional(),
            modelConfig: z
              .object({
                mode: chatModeSchema,
                selection: conversationModelSchema,
              })
              .strict()
              .optional(),
          })
          .safeParse(params);
        if (
          !steer.success ||
          // An image-only message is fine; an empty one is not.
          (!steer.data.prompt.trim() && !steer.data.images?.length)
        )
          throw new FlowError("无效的引导内容。", 400);
        // Like stop, this reaches only conversations with a coding turn
        // running in this process, never an arbitrary DSH session.
        const steered = await coding.steer(
          steer.data.sessionId,
          steer.data.prompt,
          steer.data.images ?? [],
          steer.data.modelConfig
            ? {
                ...steer.data.modelConfig,
                defaults: await resolveModeDefaults(
                  steer.data.modelConfig.mode,
                ),
              }
            : undefined,
          steer.data.requestId,
        );
        if (steered && steer.data.modelConfig)
          await conversations.selectModel(
            steer.data.sessionId,
            steer.data.modelConfig.mode,
            steer.data.modelConfig.selection,
          );
        data = { steered };
        break;
      }
      case "coding/side/open": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的主对话。", 400);
        data = {
          sessionId: await codingConversations.openSide(params.sessionId),
        };
        break;
      }
      case "coding/side/close": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的旁支对话。", 400);
        if (codingConversations.get(params.sessionId))
          throw new FlowError("只能关闭旁支对话。", 400);
        const closed = await codingConversations.closeSide(params.sessionId);
        if (closed) {
          await executions.stop(params.sessionId);
          await coding.closeSide(params.sessionId);
        }
        data = { closed };
        break;
      }
      case "coding/conversation/archive":
      case "coding/conversation/close": {
        if (
          typeof params.sessionId !== "string" ||
          (method === "coding/conversation/archive" &&
            typeof params.archived !== "boolean")
        )
          throw new FlowError("无效的对话操作。", 400);
        const parent = codingConversations.get(params.sessionId);
        if (!parent) throw new FlowError("对话不存在或已关闭。", 404);
        const closing = method === "coding/conversation/close";
        if (closing) await codingConversations.close(parent.id);
        else
          await codingConversations.archive(
            parent.id,
            params.archived === true,
          );
        if (closing || params.archived === true)
          await Promise.all(
            conversationSides(parent).map(async (side) => {
              await executions.stop(side.id);
              await coding.closeSide(side.id);
            }),
          );
        if (closing) {
          await executions.stop(parent.id);
          await coding.close(parent.id);
        }
        data = { updated: true };
        break;
      }
      case "coding/model": {
        const request = z
          .object({
            sessionId: z.string().min(1).max(200),
            mode: chatModeSchema,
            selection: conversationModelSchema,
          })
          .parse(params);
        await conversations.selectModel(
          request.sessionId,
          request.mode,
          request.selection,
        );
        data = { updated: true };
        break;
      }
      case "coding/permission": {
        const request = z
          .object({
            sessionId: z.string().min(1).max(200),
            permission: codingPermissionSchema,
          })
          .strict()
          .safeParse(params);
        if (!request.success) throw new FlowError("无效的权限设置。", 400);
        await conversations.selectPermission(
          request.data.sessionId,
          request.data.permission,
        );
        data = { updated: true };
        break;
      }
      case "automation/list":
        data = await automation.list();
        break;
      case "automation/create":
        data = await automation.create(automationInput(params));
        break;
      case "automation/update": {
        if (typeof params.id !== "string")
          throw new FlowError("无效的任务。", 400);
        data = await automation.update(params.id, automationInput(params));
        break;
      }
      case "automation/delete": {
        const input = automationRef(params);
        data = {
          deleted: await automation.remove(input.sessionId, input.id),
        };
        break;
      }
      case "automation/history": {
        const input = automationRef(params);
        data = await automation.history(input.sessionId, input.id);
        break;
      }
      case "coding/skills": {
        const input = z
          .object({ projectId: z.string().min(1).max(256) })
          .strict()
          .safeParse(params);
        if (!input.success) throw new FlowError("无效的工作空间。", 400);
        data = await codingSkills(
          ctx.skills,
          codingProjects.directory(input.data.projectId),
        );
        break;
      }
      case "coding/assistant": {
        const input = z
          .object({ create: z.boolean().default(false) })
          .strict()
          .safeParse(params);
        if (!input.success) throw new FlowError("无效的助手请求。", 400);
        const existing = codingConversations.getAssistant();
        const assistant =
          existing ??
          (input.data.create
            ? await codingConversations.openAssistant(
                (await codingProjects.defaultProject()).id,
              )
            : undefined);
        if (!assistant) {
          data = null;
          break;
        }
        const project = codingProjects
          .list()
          .find((item) => item.id === assistant.projectId);
        if (!project)
          throw new FlowError(
            "Aura 助手所属工作空间不可用，请恢复该工作空间。",
            409,
          );
        data = { conversation: assistant, project };
        break;
      }
      case "coding/conversations": {
        if (typeof params.projectId !== "string")
          throw new FlowError("无效的项目。", 400);
        codingProjects.directory(params.projectId);
        const list = codingConversations.list(params.projectId);
        if (
          params.includeStatus !== undefined &&
          typeof params.includeStatus !== "boolean"
        )
          throw new FlowError("无效的对话状态选项。", 400);
        const signal = AbortSignal.timeout(10_000);
        data = await conversationList(list, {
          includeStatus: params.includeStatus !== false,
          running: (id) => coding.running(id),
          waitingForAnswer: (id) => codingAnswers.open(id).length > 0,
          readStatus: (id) =>
            lastTurnStatus(ctx.sessionController, SessionId(id), signal),
        });
        break;
      }
      case "coding/answer": {
        if (
          typeof params.sessionId !== "string" ||
          typeof params.questionId !== "string"
        )
          throw new FlowError("无效的回答。", 400);
        const answers = codingAnswers.answer(
          params.sessionId,
          params.questionId,
          params.answers,
        );
        const execution = executions.execution(params.sessionId);
        executions.events.publish(
          params.sessionId,
          {
            type: "activity",
            activity: {
              type: "answered",
              questionId: params.questionId,
              answers,
            },
          },
          execution?.id,
        );
        data = { accepted: true };
        break;
      }
      case "coding/history": {
        if (typeof params.sessionId !== "string")
          throw new FlowError("无效的对话。", 400);
        // A retained side grants access only while its parent is open.
        // Arbitrary DSH sessions (Flow agents, ordinary chats) stay private.
        const side = codingConversations.sideParent(params.sessionId);
        if (!codingConversations.get(params.sessionId) && !side)
          throw new FlowError("对话不存在或已移除。", 404);
        const sessionId = SessionId(params.sessionId);
        const signal = AbortSignal.timeout(30_000);
        const record = codingConversations.get(params.sessionId);
        const paged = params.page === true;
        const beforeSeq = params.beforeSeq;
        const throughSeq = params.throughSeq;
        if (
          (beforeSeq !== undefined &&
            (!Number.isSafeInteger(beforeSeq) || (beforeSeq as number) < 0)) ||
          (throughSeq !== undefined &&
            (!Number.isSafeInteger(throughSeq) ||
              (throughSeq as number) < 0)) ||
          (beforeSeq === undefined) !== (throughSeq === undefined)
        )
          throw new FlowError("无效的历史分页游标。", 400);
        const inherited =
          paged && (side || record?.sourceSessionId)
            ? (ctx.sessions.get(sessionId)?.inheritedEventCount ??
              (
                await ctx.sessionController
                  .inspect(sessionId, signal)
                  .catch(() => undefined)
              )?.inheritedEventCount ??
              0)
            : 0;
        const page = paged
          ? await readSessionEventPage(
              ctx.sessionController,
              sessionId,
              signal,
              {
                beforeSeq: beforeSeq as number | undefined,
                throughSeq: throughSeq as number | undefined,
                minimumSeq: inherited,
              },
            )
          : undefined;
        const events =
          page?.events ??
          (await readSessionEvents(ctx.sessionController, sessionId, signal));
        // The inherited context is for the model, not duplicate UI history.
        const own =
          !paged && (side || record?.sourceSessionId) && events
            ? await ctx.sessionController.inspect(sessionId, signal)
            : undefined;
        const running = coding.running(params.sessionId);
        const turns = [
          ...legacyConversationTurns(
            !page?.hasMore ? (record?.history ?? []) : [],
            record?.createdAt ?? 0,
          ),
          ...sessionHistoryTurns(
            own ? own.events.slice(own.inheritedEventCount) : (events ?? []),
            running,
          ),
        ];
        // Questions still waiting carry the ids an answer must quote.
        const open = codingAnswers.open(params.sessionId);
        const last = turns.at(-1);
        if (last && running && beforeSeq === undefined)
          for (const item of open)
            last.events.push({
              type: "question",
              questionId: item.questionId,
              questions: item.questions,
            });
        const collaboration =
          beforeSeq === undefined
            ? await coding
                .collaborationState(params.sessionId, signal)
                .catch(() => undefined)
            : undefined;
        data = {
          turns,
          running,
          ...(collaboration && (collaboration.planning || collaboration.goal)
            ? { collaboration }
            : {}),
          ...(page
            ? {
                hasMore: page.hasMore,
                beforeSeq: page.beforeSeq,
                throughSeq: page.throughSeq,
              }
            : {}),
        };
        break;
      }
      default:
        return undefined;
    }
    return { data };
  }
}

const automationTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal("every"),
    everySeconds: z
      .number()
      .int()
      .min(60)
      .max(366 * 86_400),
  }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().min(1).max(16),
    timeZone: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("weekly"),
    time: z.string().min(1).max(16),
    timeZone: z.string().min(1).max(64),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1).max(200),
    timeZone: z.string().min(1).max(64),
  }),
]);

/** Browser input for a task; DSH re-validates every field it stores. */
function automationInput(params: Record<string, unknown>) {
  const input = z
    .object({
      sessionId: z.string().min(1),
      title: z.string().trim().min(1).max(120),
      prompt: z.string().trim().min(1).max(20_000),
      timing: automationTimingSchema,
    })
    .safeParse(params);
  if (!input.success) throw new FlowError("任务内容不完整。", 400);
  return input.data;
}

function automationRef(params: Record<string, unknown>) {
  if (typeof params.sessionId !== "string" || typeof params.id !== "string")
    throw new FlowError("无效的任务。", 400);
  return { sessionId: params.sessionId, id: params.id };
}
