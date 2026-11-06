import React, { useEffect, useRef, useState } from "react";
import {
  useToolMessages,
  toolMessage,
  type ToolMessageKey,
} from "../../tool-messages.ts";
import { messageText, type MessageReference } from "@aura/i18n/runtime";
import { apiErrorText } from "../../api-error-messages.ts";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleStop,
  CircleX,
  FileWarning,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { CodingSubagent } from "@aura/protocol/types";
import { WorkflowRichText } from "../../screens/WorkflowValue.tsx";
import { useAnchoredPopover } from "../../useAnchoredPopover.ts";
import { readCodingSubagents, stopCodingSubagent } from "./api.ts";

const states = {
  running: { label: "agentRunning", icon: LoaderCircle },
  complete: { label: "agentComplete", icon: CircleCheck },
  stopped: { label: "agentStopped", icon: CircleStop },
  error: { label: "agentFailed", icon: CircleX },
  unknown: { label: "agentUnknown", icon: CircleHelp },
} satisfies Record<
  CodingSubagent["status"],
  { label: ToolMessageKey; icon: typeof LoaderCircle }
>;

function AgentState({ agent }: { agent: CodingSubagent }) {
  const { icon: Icon } = states[agent.status];
  return (
    <Icon
      size={14}
      aria-hidden="true"
      className={`coding-agent-state ${agent.status}${agent.status === "running" ? " coding-spin" : ""}`}
    />
  );
}

function duration(milliseconds: number, locale: string): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60)
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "short",
    }).format(seconds);
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes < 60
    ? `${minutes}:${remainder}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}

export function SubagentPanel({
  endpoint,
  sessionId,
  running,
  open,
  anchor,
  onClose,
}: {
  endpoint: string;
  sessionId: string;
  running: boolean;
  open: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const { t, i18n } = useToolMessages();
  const label = (item: CodingSubagent) =>
    item.defaultLabel === true ? t("agentDefaultLabel") : item.label;
  const role = (item: CodingSubagent) => {
    switch (item.roleKind) {
      case "review":
        return t("agentReviewRole");
      case "research":
        return t("agentResearchRole");
      case "agent":
        return t("agentDefaultLabel");
      default:
        return item.role;
    }
  };
  const locale = i18n.resolvedLanguage ?? "en";
  const [agents, setAgents] = useState<CodingSubagent[]>([]);
  const [readError, setReadError] = useState(false);
  const [stopError, setStopError] = useState<{
    id: string;
    text: MessageReference;
  }>();
  const [stopping, setStopping] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string>();
  const popup = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, anchor, popup, { align: "end", maxHeight: 560 });

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = running || open;
    setLoading(true);
    async function load() {
      try {
        const result = await readCodingSubagents(
          endpoint,
          sessionId,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setAgents((previous) =>
          result.map((agent) => {
            const cached = previous.find((item) => item.id === agent.id);
            return agent.recordError && cached
              ? {
                  ...cached,
                  ...agent,
                  role: cached.role,
                  roleKind: cached.roleKind,
                  result: cached.result,
                  durationMs: cached.durationMs,
                }
              : agent;
          }),
        );
        setReadError(false);
        polling =
          running || open || result.some((agent) => agent.status === "running");
      } catch {
        if (abort.signal.aborted) return;
        setReadError(true);
      }
      if (abort.signal.aborted) return;
      setLoading(false);
      if (polling) timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, sessionId, running, refresh, open]);

  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, selected, anchor, onClose]);

  const agent = agents.find((item) => item.id === selected);
  const retry = () => setRefresh((value) => value + 1);
  const close = () => {
    onClose();
    anchor.current?.focus();
  };

  return (
    <>
      {open ? (
        <div
          ref={popup}
          popover="manual"
          role="dialog"
          aria-label={
            agent ? t("agentTitle", { name: label(agent) }) : t("agentCatalog")
          }
          className={`coding-agents-popup${agent ? " coding-agents-detail" : ""}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (
              !agent &&
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              const rows = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  ".coding-agent-row",
                ),
              );
              if (!rows.length) return;
              event.preventDefault();
              const current = rows.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : (current +
                        (event.key === "ArrowDown" ? 1 : rows.length - 1) +
                        rows.length) %
                      rows.length;
              rows[next]?.focus();
            }
          }}
        >
          <div className="coding-agents-heading">
            {agent ? (
              <button
                type="button"
                className="icon-control"
                aria-label={t("backAgents")}
                onClick={() => setSelected(undefined)}
              >
                <ArrowLeft size={14} />
              </button>
            ) : null}
            <span>{agent ? label(agent) : t("agents")}</span>
            <button
              type="button"
              className="icon-control"
              aria-label={t("refreshAgents")}
              disabled={loading}
              onClick={retry}
            >
              <RefreshCw
                size={14}
                className={loading ? "coding-spin" : undefined}
              />
            </button>
            <button
              type="button"
              className="icon-control"
              aria-label={t("closeAgents")}
              onClick={close}
            >
              <X size={14} />
            </button>
          </div>
          {readError ? (
            <p className="coding-agent-read-error" role="alert">
              <FileWarning size={14} aria-hidden="true" />
              <span>{t("agentListFailed")}</span>
            </p>
          ) : null}
          <div className="coding-agents-body">
            {!agents.length ? (
              <p className="coding-agent-empty">
                {loading
                  ? t("loadingAgents")
                  : readError
                    ? t("agentsUnavailable")
                    : t("noAgents")}
              </p>
            ) : null}
            {agent ? (
              <>
                <div className="coding-agent-meta">
                  <AgentState agent={agent} />
                  <span>{t(states[agent.status].label)}</span>
                  <span>· {role(agent)}</span>
                  {agent.durationMs !== undefined ? (
                    <span>· {duration(agent.durationMs, locale)}</span>
                  ) : null}
                </div>
                {agent.recordError ? (
                  <div className="coding-agent-read-error" role="alert">
                    <FileWarning size={14} aria-hidden="true" />
                    <span>
                      {t("agentRecordFailed", {
                        reason: messageText(
                          apiErrorText(
                            agent.recordErrorDetails,
                            agent.recordError,
                          ),
                          i18n,
                        ),
                      })}
                      {agent.result ? t("agentCachedResult") : ""}
                    </span>
                    <button type="button" disabled={loading} onClick={retry}>
                      {t("reread")}
                    </button>
                  </div>
                ) : null}
                {agent.status === "error" ? (
                  <p className="coding-agent-execution-error" role="alert">
                    {messageText(
                      apiErrorText(
                        agent.executionErrorDetails,
                        agent.executionError ?? toolMessage("agentFailure"),
                      ),
                      i18n,
                    )}
                  </p>
                ) : null}
                {agent.result ? (
                  <WorkflowRichText text={agent.result} />
                ) : (
                  <p className="coding-agent-empty">
                    {agent.recordError
                      ? t("agentAwaitRecord")
                      : agent.status === "running"
                        ? t("agentAwaitResult")
                        : agent.status === "complete"
                          ? t("agentNoTextComplete")
                          : agent.status === "stopped"
                            ? t("agentNoTextStopped")
                            : agent.status === "error"
                              ? t("agentNoTextFailed")
                              : t("agentNoResult")}
                  </p>
                )}
                {stopError?.id === agent.id ? (
                  <p className="coding-agent-execution-error" role="alert">
                    {messageText(stopError.text, i18n)}
                  </p>
                ) : null}
                {agent.status === "running" ? (
                  <button
                    type="button"
                    className="coding-agent-stop"
                    disabled={stopping === agent.id || Boolean(readError)}
                    onClick={async () => {
                      setStopping(agent.id);
                      setStopError(undefined);
                      try {
                        await stopCodingSubagent(endpoint, sessionId, agent.id);
                        retry();
                      } catch {
                        setStopError({
                          id: agent.id,
                          text: toolMessage("agentStopUnknown"),
                        });
                      } finally {
                        setStopping(undefined);
                      }
                    }}
                  >
                    <CircleStop size={14} aria-hidden="true" />
                    {stopping === agent.id
                      ? t("agentStopping")
                      : t("stopAgent")}
                  </button>
                ) : null}
              </>
            ) : (
              <ul className="coding-agents-list" aria-label={t("agentList")}>
                {agents.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="coding-agent-row"
                      onClick={() => setSelected(item.id)}
                    >
                      <AgentState agent={item} />
                      <span className="coding-agent-copy">
                        <span className="coding-agent-label">
                          {label(item)}
                        </span>
                        <span className="coding-agent-summary">
                          {role(item)} · {t(states[item.status].label)}
                          {item.recordError
                            ? ` · ${t("recordReadFailed")}`
                            : ""}
                        </span>
                      </span>
                      {item.durationMs !== undefined ? (
                        <span className="coding-agent-duration">
                          {duration(item.durationMs, locale)}
                        </span>
                      ) : null}
                      <ChevronRight size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
