/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import type { FlowMode, FlowPhase, FlowStepPhase } from "@aura/protocol/types";
import {
  language,
  registerCatalogs,
  type MessageReference,
} from "@aura/i18n/runtime";
import zh from "./locales/zh-CN/workflow.json" with { type: "json" };
import en from "./locales/en/workflow.json" with { type: "json" };
import ja from "./locales/ja/workflow.json" with { type: "json" };
import ko from "./locales/ko/workflow.json" with { type: "json" };
import ru from "./locales/ru/workflow.json" with { type: "json" };
import fr from "./locales/fr/workflow.json" with { type: "json" };
const dispose = registerCatalogs("workflow", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
export type WorkflowMessageKey = keyof typeof en;
export type WorkflowTranslate = (
  key: WorkflowMessageKey,
  values?: Record<string, string | number>,
) => string;
export const workflowText: WorkflowTranslate = (key, values) =>
  language.i18n.t(key, { ...values, ns: "workflow" });
const phases: Record<FlowPhase | FlowStepPhase, WorkflowMessageKey> = {
  queued: "phaseQueued",
  running: "phaseRunning",
  completed: "phaseCompleted",
  failed: "phaseFailed",
  cancelled: "phaseCancelled",
  interrupted: "phaseInterrupted",
  pausing: "phasePausing",
  paused: "phasePaused",
  waiting_input: "phaseWaitingInput",
  needs_attention: "phaseNeedsAttention",
  unknown: "phaseUnknown",
};
/** Display projection only; persisted legacy labels remain in workflowSessions. */
export function workflowPhaseText(
  phase: FlowPhase | FlowStepPhase,
  t: WorkflowTranslate = workflowText,
): string {
  return t(phases[phase]);
}
export function workflowModeText(
  mode: FlowMode,
  t: WorkflowTranslate = workflowText,
): string {
  return mode === "codex"
    ? "Codex"
    : mode === "lumina"
      ? "Lumina"
      : t(mode === "demo" ? "demo" : "customApi");
}
export function useWorkflowMessages() {
  return useMessages<WorkflowMessageKey>("workflow");
}
export function workflowMessage(
  key: WorkflowMessageKey,
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "workflow", key, ...(values ? { values } : {}) };
}
