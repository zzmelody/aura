import { validateChatModelSelection } from "@aura/protocol";
import type {
  Message,
  Session,
  Workspace,
  WorkflowBinding,
  WorkflowRef,
} from "./types.ts";
import { initialState } from "./workspace.ts";
import { validateEndpoint } from "./endpoint.ts";
const flowModes = new Set<string>(["demo", "codex", "lumina", "custom"]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreRef(value: unknown): WorkflowRef | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.endpoint !== "string"
  )
    return undefined;
  const endpoint = validateEndpoint(value.endpoint);
  return endpoint ? { id: value.id, title: value.title, endpoint } : undefined;
}

function restoreImages(value: unknown[]): NonNullable<Message["images"]> {
  return value
    .filter(
      (image): image is Record<string, unknown> =>
        isRecord(image) &&
        typeof image.assetId === "string" &&
        /^[a-f0-9]{64}$/u.test(image.assetId) &&
        ["image/png", "image/jpeg", "image/webp"].includes(
          image.mimeType as string,
        ),
    )
    .slice(0, 4)
    .map((image) => ({
      assetId: image.assetId as string,
      mimeType: image.mimeType as "image/png" | "image/jpeg" | "image/webp",
      ...(typeof image.width === "number" ? { width: image.width } : {}),
      ...(typeof image.height === "number" ? { height: image.height } : {}),
      ...(typeof image.name === "string"
        ? { name: image.name.slice(0, 180) }
        : {}),
    }));
}

function restoreBinding(value: unknown): WorkflowBinding | undefined {
  const ref = restoreRef(value);
  if (!ref || !isRecord(value)) return undefined;
  return {
    ...ref,
    ...(value.inputSchema && typeof value.inputSchema === "object"
      ? { inputSchema: value.inputSchema as WorkflowBinding["inputSchema"] }
      : {}),
    ...(isRecord(value.pending) &&
    typeof value.pending.requestId === "string" &&
    flowModes.has(String(value.pending.mode)) &&
    value.pending.input !== undefined
      ? { pending: value.pending as WorkflowBinding["pending"] }
      : {}),
  };
}

/**
 * Restores bounded v1 history and marks interrupted generation as stopped.
 */
export function restoreState(value: unknown): Workspace {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions))
    return initialState();
  const sessions: Session[] = [];
  for (const s of value.sessions) {
    if (sessions.length === 100) break;
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      typeof s.title !== "string" ||
      typeof s.updatedAt !== "number" ||
      !Array.isArray(s.messages)
    )
      continue;
    const messages: Message[] = [];
    const workflow = restoreBinding(s.workflow);
    const pendingBinding = restoreBinding(s.pendingWorkflow);
    const pendingWorkflow =
      !workflow && pendingBinding?.pending
        ? { ...pendingBinding, pending: pendingBinding.pending }
        : undefined;
    for (const m of s.messages) {
      if (
        !isRecord(m) ||
        typeof m.id !== "string" ||
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.text !== "string"
      )
        continue;
      const ref = restoreRef(m.workflow);
      messages.push({
        id: m.id,
        role: m.role,
        text: m.text,
        status:
          m.status === "streaming"
            ? "stopped"
            : m.status === "stopped" || m.status === "error"
              ? m.status
              : "complete",
        ...(m.role === "user" && Array.isArray(m.images)
          ? { images: restoreImages(m.images) }
          : {}),
        ...(ref && !workflow ? { workflow: ref } : {}),
        ...((workflow || ref) && typeof m.workflowRunId === "string"
          ? { workflowRunId: m.workflowRunId }
          : {}),
        ...((workflow || ref) &&
        typeof m.workflowPhase === "string" &&
        [
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "pausing",
          "paused",
          "waiting_input",
          "needs_attention",
        ].includes(m.workflowPhase)
          ? { workflowPhase: m.workflowPhase as Message["workflowPhase"] }
          : {}),
      });
    }
    sessions.push({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messages: messages.slice(-200),
      ...(typeof s.archivedAt === "number" &&
      Number.isFinite(s.archivedAt) &&
      s.archivedAt > 0
        ? { archivedAt: s.archivedAt }
        : {}),
      ...(!workflow && isRecord(s.modelConfig)
        ? {
            modelConfig: Object.fromEntries(
              Object.entries(s.modelConfig).filter(
                ([mode, config]) =>
                  flowModes.has(mode) && validateChatModelSelection(config),
              ),
            ),
          }
        : {}),
      ...(workflow ? { workflow } : {}),
      ...(pendingWorkflow ? { pendingWorkflow } : {}),
    });
  }
  return {
    version: 1,
    theme:
      value.theme === "light" || value.theme === "system"
        ? value.theme
        : "dark",
    reduceMotion: value.reduceMotion === true,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    provider: ["dsh", "codex", "lumina", "custom"].includes(
      String(value.provider),
    )
      ? (value.provider as Workspace["provider"])
      : "offline",
    sessions,
    ...(typeof value.sidebarWidth === "number" &&
    Number.isFinite(value.sidebarWidth)
      ? {
          sidebarWidth: Math.max(
            240,
            Math.min(480, Math.round(value.sidebarWidth)),
          ),
        }
      : {}),
    ...(Array.isArray(value.hiddenWorkflowRuns)
      ? {
          hiddenWorkflowRuns: value.hiddenWorkflowRuns
            .filter((item): item is string => typeof item === "string")
            .slice(-500),
        }
      : {}),
  };
}
