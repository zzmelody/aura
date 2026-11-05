import type {
  ChatModelSelection,
  CodingPermission,
  FlowMode,
} from "@aura/protocol/types";
import {
  conversationSides,
  PERSONAL_ASSISTANT_SESSION_ID,
} from "@aura/protocol/conversations";
import type { CodingStreamEvent, CodingTurn } from "../types.ts";
import { FlowError } from "@aura/protocol/errors";
import type { CodingConversationIndex } from "./index-record.ts";
import type { ConversationWorkspaces } from "../ports.ts";
import type { codingService } from "./session.ts";
import type { ConversationTitleGenerator } from "./conversation-title.ts";

/** Admission and durable metadata; model execution stays in the DSH driver. */
export function conversationService(
  projects: ConversationWorkspaces,
  index: CodingConversationIndex,
  driver: Pick<ReturnType<typeof codingService>, "stream" | "applyPermission">,
  generateTitle?: ConversationTitleGenerator,
) {
  const admitted = new Set<string>();
  return { stream, selectModel, selectPermission };

  /** Saves the choice and applies it to a live agent at once, mid-turn too. */
  async function selectPermission(id: string, permission: CodingPermission) {
    await index.selectPermission(id, permission);
    const current = index.permission(id);
    if (!current) return;
    driver.applyPermission(id, current);
    const parent = index.get(id);
    if (parent)
      for (const side of conversationSides(parent)) {
        if (!side.permission) driver.applyPermission(side.id, current);
      }
  }

  async function selectModel(
    id: string,
    mode: FlowMode,
    selection: ChatModelSelection,
  ) {
    await index.selectModel(id, mode, selection);
  }

  async function stream(
    request: Omit<CodingTurn, "project">,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ) {
    const id = request.sessionId;
    if (admitted.has(id)) throw new FlowError("这段对话还有一轮在进行。", 409);
    admitted.add(id);
    try {
      const projectId =
        request.projectId ?? (await projects.defaultProject()).id;
      const directory = projects.directory(projectId);
      const parentId = request.forkFrom ?? request.branchFrom;
      const parent = parentId
        ? (index.get(parentId) ??
          (request.branchFrom ? index.sideParent(parentId) : undefined))
        : undefined;
      if (request.forkFrom && request.branchFrom)
        throw new FlowError("不能同时创建旁支和跨项目延续。", 400);
      if (request.branchAt !== undefined && !request.branchFrom)
        throw new FlowError("分叉轮次缺少来源对话。", 400);
      if (
        parentId &&
        (!parent || parent.archivedAt !== undefined || parentId === id)
      )
        throw new FlowError("来源对话不存在或已归档。", 404);
      if (
        request.forkFrom &&
        (parent?.projectId !== projectId ||
          index.sideParent(id)?.id !== parentId ||
          !id.startsWith("side-"))
      )
        throw new FlowError("旁支已关闭或不属于当前项目。", 404);
      const existing = index.get(id);
      if (
        request.branchFrom &&
        existing &&
        (existing.sourceSessionId !== request.branchFrom ||
          existing.sourceEndSeq !== request.branchAt)
      )
        throw new FlowError("对话来源不匹配。", 409);
      if (!request.forkFrom) {
        const initialPermission =
          request.permission ??
          (request.branchFrom
            ? index.permission(request.branchFrom)
            : undefined);
        await index.open(id, projectId, request.prompt, {
          ...(request.history?.length ? { history: request.history } : {}),
          ...(request.branchFrom
            ? {
                sourceSessionId: request.branchFrom,
                sourceEndSeq: request.branchAt,
              }
            : {}),
          ...(initialPermission ? { permission: initialPermission } : {}),
        });
      }
      if (request.permission && (existing || request.forkFrom))
        await selectPermission(id, request.permission);
      const saved =
        index.modelConfig(id)?.[request.mode] ??
        (parentId ? index.modelConfig(parentId)?.[request.mode] : undefined) ??
        parent?.modelConfig?.[request.mode];
      const selection =
        request.model !== undefined || request.reasoningEffort !== undefined
          ? {
              ...(request.model ? { model: request.model } : {}),
              ...(request.reasoningEffort
                ? { reasoningEffort: request.reasoningEffort }
                : {}),
            }
          : (saved ?? {});
      // Explicit empty selection is saved by the model control endpoint.
      await index.selectModel(id, request.mode, selection);
      const firstTurn = request.forkFrom
        ? await index.nameSide(id, request.prompt)
        : !existing;
      const sideParent = request.forkFrom ? index.sideParent(id) : undefined;
      const provisionalTitle = sideParent
        ? conversationSides(sideParent).find((side) => side.id === id)?.title
        : index.get(id)?.title;
      const result = await driver.stream(
        {
          ...request,
          ...selection,
          projectId,
          project: directory,
          history: index.get(id)?.history,
          branchAt: request.branchAt ?? existing?.sourceEndSeq,
          ...((parentId ?? existing?.sourceSessionId)
            ? { forkFrom: parentId ?? existing?.sourceSessionId }
            : {}),
        },
        emit,
        signal,
        () => index.permission(id),
      );
      if (!request.forkFrom) await projects.attach(projectId, id);
      if (
        firstTurn &&
        generateTitle &&
        provisionalTitle &&
        request.prompt.trim() &&
        id !== PERSONAL_ASSISTANT_SESSION_ID &&
        !signal.aborted
      ) {
        try {
          const title = await generateTitle(
            { ...request, ...selection },
            signal,
          );
          if (!signal.aborted)
            await index.setGeneratedTitle(id, provisionalTitle, title);
        } catch {
          // The main reply is already complete; a title failure must not fail it
          // or retry an auxiliary request with an unknown paid outcome.
          if (!signal.aborted)
            emit({
              type: "notice",
              id: `title-${id}`,
              text: "标题未能自动提炼，已保留临时标题。可在模型服务的对话能力中检查请求额度。",
              at: Date.now(),
            });
        }
      }
      return result;
    } finally {
      admitted.delete(id);
    }
  }
}
