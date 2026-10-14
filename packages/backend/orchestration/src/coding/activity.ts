import type { CodingFileDiff, CodingStreamEvent } from "../types.ts";

/**
 * Projects one DSH session event into the coding activity stream. Live turns
 * and replayed history both go through here, so they show the same steps.
 */
export function projectCodingEvent(
  event: { type: string; data?: unknown },
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
    const result = toolResult(fields);
    if (result) {
      const pending = created.get(result.toolCallId);
      created.delete(result.toolCallId);
      let diffs = resultDiffs(fields.meta);
      if (!diffs.length && pending && !result.isError) diffs = [pending];
      emit({
        type: "tool",
        phase: "end",
        callId: result.toolCallId,
        ok: !result.isError,
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
