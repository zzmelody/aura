import type { ChatModelSelection, FlowMode } from "@aura/protocol/types";
import type { CodingStreamEvent, CodingTurn } from "../types.ts";
import { FlowError } from "../schema.ts";
import type { CodingConversationIndex } from "./index-record.ts";
import type { CodingProjects } from "./projects.ts";
import type { codingService } from "./session.ts";

/** Admission and durable metadata; model execution stays in the DSH driver. */
export function conversationService(
  projects: CodingProjects,
  index: CodingConversationIndex,
  driver: ReturnType<typeof codingService>,
) {
  const admitted = new Set<string>();
  return { stream, selectModel };

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
        await index.open(id, projectId, request.prompt, {
          ...(request.history?.length ? { history: request.history } : {}),
          ...(request.branchFrom
            ? {
                sourceSessionId: request.branchFrom,
                sourceEndSeq: request.branchAt,
              }
            : {}),
        });
      }
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
      if (request.forkFrom) await index.nameSide(id, request.prompt);
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
      );
      if (!request.forkFrom) await projects.attach(projectId, id);
      return result;
    } finally {
      admitted.delete(id);
    }
  }
}
