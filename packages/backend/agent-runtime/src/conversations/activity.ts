import { isCodingSteerRequestId } from "@aura/protocol";
import type { CodingFileDiff, CodingTimelineEvent } from "../types.ts";

/**
 * Projects one DSH session event into the coding activity stream. Live turns
 * and replayed history both go through here, so they show the same steps.
 *
 * @param ownPrompt - whether a user message is the request that opened this
 *   turn. Every other user message inside it is steering the user sent while
 *   the turn ran, which shows as its own transcript entry. Omitting the test
 *   projects no user message at all, as callers that track prompts themselves
 *   require.
 */
export function projectCodingEvent(
  event: { type: string; time: number; data?: unknown },
  emit: (event: CodingTimelineEvent) => void,
  created: Map<string, CodingFileDiff>,
  ownPrompt?: (message: Record<string, unknown>) => boolean,
) {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return;
  const fields = data as Record<string, unknown>;
  const at = event.time;
  if (
    event.type === "agent/inbox/spliced" &&
    fields.target === "next-step" &&
    Array.isArray(fields.inserted) &&
    ownPrompt
  ) {
    for (const inserted of fields.inserted) {
      if (!inserted || typeof inserted !== "object") continue;
      const message = inserted as Record<string, unknown>;
      const source = message.source as
        { kind?: unknown; rpcId?: unknown } | undefined;
      if (
        source?.kind !== "user" ||
        !isCodingSteerRequestId(source.rpcId) ||
        ownPrompt(message)
      )
        continue;
      const text = messageText(message.content);
      if (text)
        emit({
          type: "steer",
          text,
          requestId: source.rpcId,
          delivery: "queued",
          at,
        });
    }
    return;
  }
  if (
    event.type.startsWith("compaction/") &&
    typeof fields.compactionId === "string"
  ) {
    const text =
      event.type === "compaction/start"
        ? "正在压缩较早的上下文…"
        : event.type === "compaction/summary" &&
            typeof fields.shadowedTokenCount === "number"
          ? `已概括较早上下文（原约 ${fields.shadowedTokenCount} tokens），原始聊天记录仍然保留。`
          : event.type === "compaction/end" && fields.error
            ? "上下文压缩未完成。"
            : undefined;
    if (text) emit({ type: "notice", id: fields.compactionId, text, at });
  }
  // Model spans for the trajectory: a step opens a model request, the
  // assistant message (or an interrupted attempt) closes it.
  if (event.type === "step/start") {
    emit({ type: "model", phase: "start", at });
    return;
  }
  if (event.type === "assistant/message") {
    emit({ type: "model", phase: "end", at });
    return;
  }
  if (event.type === "user/message" && ownPrompt && !ownPrompt(fields)) {
    // Only what the user actually typed: injected context, model-selection
    // notices and other producers carry their own source kind.
    const source = fields.source as
      { kind?: unknown; rpcId?: unknown } | undefined;
    if (source?.kind !== "user") return;
    const text = messageText(fields.content);
    if (text)
      emit({
        type: "steer",
        text,
        at,
        ...(isCodingSteerRequestId(source.rpcId)
          ? { requestId: source.rpcId }
          : {}),
      });
    return;
  }
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
        at,
        ...(detail ? { detail } : {}),
      });
    }
  }
  if (event.type === "tool/result") {
    const result = toolResult(fields);
    if (result) {
      const web = webMetadata(fields.meta);
      if (web && !result.isError)
        emit({ type: "web", callId: result.toolCallId, ...web, at });
      const pending = created.get(result.toolCallId);
      created.delete(result.toolCallId);
      let diffs = resultDiffs(fields.meta);
      if (!diffs.length && pending && !result.isError) diffs = [pending];
      emit({
        type: "tool",
        phase: "end",
        callId: result.toolCallId,
        ok: !result.isError,
        at,
        ...(diffs.length ? { diffs } : {}),
      });
      try {
        const value = JSON.parse(messageText(result.content)) as {
          workflow?: {
            runId?: unknown;
            flowId?: unknown;
            title?: unknown;
            inputPreview?: unknown;
          };
        };
        const run = value?.workflow;
        if (
          typeof run?.runId === "string" &&
          typeof run.flowId === "string" &&
          typeof run.title === "string"
        )
          emit({
            type: "workflow",
            runId: run.runId,
            flowId: run.flowId,
            title: run.title,
            inputPreview:
              typeof run.inputPreview === "string" ? run.inputPreview : "",
          });
      } catch {
        // Most tools return plain text, not a workflow reference.
      }
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

/** The text blocks of one message's content, joined and trimmed. */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * The call id, failure flag and text content of a `tool/result` event. DSH 0.2
 * puts the id and flag on the tool message itself; logs written by 0.1 carry
 * them on a single wrapping block, so replay accepts both.
 */
export function toolResult(
  data: Record<string, unknown>,
): { toolCallId: string; isError: boolean; content: unknown } | undefined {
  const message = data.message as
    { toolCallId?: unknown; isError?: unknown; content?: unknown } | undefined;
  if (typeof message?.toolCallId === "string")
    return {
      toolCallId: message.toolCallId,
      isError: message.isError === true,
      content: message.content,
    };
  const block = Array.isArray(message?.content)
    ? (message.content[0] as
        | { toolCallId?: unknown; isError?: unknown; content?: unknown }
        | undefined)
    : undefined;
  return typeof block?.toolCallId === "string"
    ? {
        toolCallId: block.toolCallId,
        isError: block.isError === true,
        content: block.content,
      }
    : undefined;
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
  for (const key of [
    "file_path",
    "path",
    "command",
    "pattern",
    "url",
    "label",
  ]) {
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

/** Project only citeable HTTP(S) URLs from DSH's native Web presentation metadata. */
function webMetadata(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;
  if (typeof meta.truncated !== "boolean") return undefined;
  const inputs = Array.isArray(meta.sources)
    ? meta.sources
    : typeof meta.url === "string"
      ? [{ url: meta.url }]
      : undefined;
  if (!inputs) return undefined;
  const sources = inputs.slice(0, 50).flatMap((source: unknown) => {
    if (!source || typeof source !== "object") return [];
    const item = source as Record<string, unknown>;
    if (typeof item.url !== "string") return [];
    try {
      const url = new URL(item.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return [];
      return [
        {
          url: url.href,
          title:
            typeof item.title === "string"
              ? item.title.slice(0, 500)
              : url.hostname,
        },
      ];
    } catch {
      return [];
    }
  });
  return {
    sources,
    truncated: meta.truncated,
    ...(typeof meta.statusCode === "number"
      ? { statusCode: meta.statusCode }
      : {}),
  };
}
