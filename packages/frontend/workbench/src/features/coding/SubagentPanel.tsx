import React, { useEffect, useRef, useState } from "react";
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
  running: { label: "执行中", icon: LoaderCircle },
  complete: { label: "已完成", icon: CircleCheck },
  stopped: { label: "已停止", icon: CircleStop },
  error: { label: "执行失败", icon: CircleX },
  unknown: { label: "状态待确认", icon: CircleHelp },
};

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

function duration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
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
  const [agents, setAgents] = useState<CodingSubagent[]>([]);
  const [readError, setReadError] = useState("");
  const [stopError, setStopError] = useState<{ id: string; text: string }>();
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
                  result: cached.result,
                  durationMs: cached.durationMs,
                }
              : agent;
          }),
        );
        setReadError("");
        polling =
          running || open || result.some((agent) => agent.status === "running");
      } catch {
        if (abort.signal.aborted) return;
        setReadError("子 Agent 列表读取失败。已有内容为上次读取的记录。");
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
          aria-label={agent ? `子 Agent：${agent.label}` : "子 Agent 目录"}
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
                aria-label="返回子 Agent 目录"
                onClick={() => setSelected(undefined)}
              >
                <ArrowLeft size={14} />
              </button>
            ) : null}
            <span>{agent ? agent.label : "子 Agent"}</span>
            <button
              type="button"
              className="icon-control"
              aria-label="重新读取子 Agent 记录"
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
              aria-label="关闭子 Agent"
              onClick={close}
            >
              <X size={14} />
            </button>
          </div>
          {readError ? (
            <p className="coding-agent-read-error" role="alert">
              <FileWarning size={14} aria-hidden="true" />
              <span>{readError}</span>
            </p>
          ) : null}
          <div className="coding-agents-body">
            {!agents.length ? (
              <p className="coding-agent-empty">
                {loading
                  ? "正在读取子 Agent…"
                  : readError
                    ? "暂时无法读取子 Agent 目录。"
                    : "这段对话还没有子 Agent。"}
              </p>
            ) : null}
            {agent ? (
              <>
                <div className="coding-agent-meta">
                  <AgentState agent={agent} />
                  <span>{states[agent.status].label}</span>
                  <span>· {agent.role}</span>
                  {agent.durationMs !== undefined ? (
                    <span>· {duration(agent.durationMs)}</span>
                  ) : null}
                </div>
                {agent.recordError ? (
                  <div className="coding-agent-read-error" role="alert">
                    <FileWarning size={14} aria-hidden="true" />
                    <span>
                      记录读取失败。{agent.recordError}
                      {agent.result ? "以下为上次读取的结果。" : ""}
                    </span>
                    <button type="button" disabled={loading} onClick={retry}>
                      重新读取
                    </button>
                  </div>
                ) : null}
                {agent.status === "error" ? (
                  <p className="coding-agent-execution-error" role="alert">
                    {agent.executionError ??
                      "子 Agent 执行失败，未正常完成任务。"}
                  </p>
                ) : null}
                {agent.result ? (
                  <WorkflowRichText text={agent.result} />
                ) : (
                  <p className="coding-agent-empty">
                    {agent.recordError
                      ? "记录恢复可读后可查看结果。"
                      : agent.status === "running"
                        ? "正在执行，等待子 Agent 返回结果。"
                        : agent.status === "complete"
                          ? "子 Agent 已完成，未返回文本结果。"
                          : agent.status === "stopped"
                            ? "子 Agent 已停止，尚无文本结果。"
                            : agent.status === "error"
                              ? "执行失败，尚无文本结果。"
                              : "尚无可确认的执行结果。"}
                  </p>
                )}
                {stopError?.id === agent.id ? (
                  <p className="coding-agent-execution-error" role="alert">
                    {stopError.text}
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
                          text: "停止请求未确认，请重新读取状态。",
                        });
                      } finally {
                        setStopping(undefined);
                      }
                    }}
                  >
                    <CircleStop size={14} aria-hidden="true" />
                    {stopping === agent.id ? "正在停止…" : "停止此 Agent"}
                  </button>
                ) : null}
              </>
            ) : (
              <ul className="coding-agents-list" aria-label="子 Agent 列表">
                {agents.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="coding-agent-row"
                      onClick={() => setSelected(item.id)}
                    >
                      <AgentState agent={item} />
                      <span className="coding-agent-copy">
                        <span className="coding-agent-label">{item.label}</span>
                        <span className="coding-agent-summary">
                          {item.role} · {states[item.status].label}
                          {item.recordError ? " · 记录读取失败" : ""}
                        </span>
                      </span>
                      {item.durationMs !== undefined ? (
                        <span className="coding-agent-duration">
                          {duration(item.durationMs)}
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
