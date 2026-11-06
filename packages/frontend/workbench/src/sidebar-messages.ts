/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { language, registerCatalogs } from "@aura/i18n/runtime";
import type { FlowPhase, FlowStepPhase } from "@aura/protocol/types";
import zh from "./locales/zh-CN/sidebar.json" with { type: "json" };
import en from "./locales/en/sidebar.json" with { type: "json" };
import ja from "./locales/ja/sidebar.json" with { type: "json" };
import ko from "./locales/ko/sidebar.json" with { type: "json" };
import ru from "./locales/ru/sidebar.json" with { type: "json" };
import fr from "./locales/fr/sidebar.json" with { type: "json" };

const dispose = registerCatalogs("sidebar", { "zh-CN": zh, en, ja, ko, ru, fr });
if (import.meta.hot) import.meta.hot.dispose(dispose);

export type SidebarMessageKey = keyof typeof en;

export function useSidebarMessages() {
  return useMessages<SidebarMessageKey>("sidebar");
}

/** Translate render-time projections; never use this to rewrite saved text. */
export function sidebarMessage(
  key: SidebarMessageKey,
  values?: Record<string, string | number>,
): string {
  return language.i18n.t(key, { ...values, ns: "sidebar" });
}

export const workflowPhaseMessageKeys: Record<
  FlowPhase | FlowStepPhase,
  SidebarMessageKey
> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  pausing: "pausing",
  paused: "paused",
  waiting_input: "waitingInput",
  needs_attention: "attention",
  unknown: "unknown",
};
