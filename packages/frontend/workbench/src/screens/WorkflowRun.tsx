import React, { useEffect, useId, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import type {
  FlowHistory,
  FlowRun,
  FlowStep,
  JsonValue,
} from "@aura/protocol/types";
import type { Message } from "@aura/core/types";
import {
  hasWorkflowContent,
  storedWorkflowValue,
  workflowDuration,
  workflowProgress,
} from "../workflowPresentation";
import { WorkflowData, WorkflowJson, WorkflowRichText } from "./WorkflowValue";
import {
  isWorkflowActive,
  workflowApi,
  workflowPhaseLabels,
} from "../workflowSessions";

function StepHistory({
  endpoint,
  runId,
  step,
}: {
  endpoint: string;
  runId: string;
  step: FlowStep;
}) {
  const [history, setHistory] = useState<FlowHistory>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.id)}/history`;
  useEffect(() => {
    if (step.kind === "action") return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    workflowApi<FlowHistory>(endpoint, path, undefined, abort.signal)
      .then(setHistory)
      .catch((cause) => {
        if (!abort.signal.aborted) setError(String(cause.message));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [endpoint, path, revision, step.kind]);
  async function older() {
    if (!history || busy) return;
    setBusy(true);
    setError("");
    try {
      const before =
        history.beforeSeq ??
        Math.min(...history.entries.map((entry) => entry.seq));
      const page = await workflowApi<FlowHistory>(
        endpoint,
        `${path}?beforeSeq=${before}`,
      );
      setHistory({
        ...page,
        entries: [
          ...page.entries,
          ...history.entries.filter(
            (entry) => !page.entries.some((older) => older.seq === entry.seq),
          ),
        ],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-step-detail">
      {step.error ? <p className="error">{step.error}</p> : null}
      {step.kind === "action" ? (
        <>
          <h4>工具输入</h4>
          <WorkflowData value={step.input} />
          <h4>工具输出</h4>
          {step.output === undefined ? (
            <p className="muted">等待输出</p>
          ) : (
            <WorkflowData value={step.output} />
          )}
        </>
      ) : (
        <>
          <div className="workflow-history-actions">
            <span>Agent 对话记录</span>
            <button
              className="icon-control"
              aria-label="刷新步骤记录"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={13} />
            </button>
          </div>
          {history?.hasMore ? (
            <button
              className="tool-button"
              disabled={busy}
              onClick={() => void older()}
            >
              加载更早记录
            </button>
          ) : null}
          {history?.entries.map((entry) => (
            <div className="workflow-history-entry" key={entry.seq}>
              <small>
                {
                  {
                    user: "输入",
                    assistant: "Agent 回复",
                    tool: "工具结果",
                    event: "执行事件",
                  }[entry.kind]
                }
              </small>
              <WorkflowRichText text={entry.text} />
            </div>
          ))}
          {!history?.entries.length ? (
            <p className="muted">{busy ? "正在读取…" : "暂无对话记录"}</p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowRunResult({
  endpoint,
  message,
  cached,
  receive,
  input,
  index,
  inputSchema,
  onCancel,
}: {
  endpoint: string;
  message: Message;
  cached?: FlowRun;
  receive(endpoint: string, run: FlowRun): void;
  input?: Message;
  index: number;
  inputSchema?: JsonValue;
  onCancel(): void;
}) {
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [stepId, setStepId] = useState<string>();
  const id = message.workflowRunId!;
  const titleId = useId();
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const run = await workflowApi<FlowRun>(
          endpoint,
          `/runs/${encodeURIComponent(id)}`,
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setError("");
        receive(endpoint, run);
        if (isWorkflowActive(run.status)) timer = setTimeout(poll, 1800);
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取失败");
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, id, revision, receive]);
  const phase = cached?.status ?? message.workflowPhase ?? "queued";
  const selected = cached?.steps.find((step) => step.id === stepId);
  const active = isWorkflowActive(phase);
  const progress = workflowProgress(cached);
  const inputValue = cached
    ? cached.input
    : input
      ? storedWorkflowValue(input.text)
      : undefined;
  const savedOutput =
    message.text &&
    !Object.values(workflowPhaseLabels).includes(message.text) &&
    message.text !== "正在运行"
      ? storedWorkflowValue(message.text)
      : undefined;
  const output = cached ? cached.output : savedOutput;
  const problem =
    cached?.error ?? (phase === "failed" && !cached ? message.text : undefined);
  const PhaseIcon =
    phase === "completed" ? CheckCircle2 : active ? LoaderCircle : CircleAlert;
  return (
    <article
      className={`workflow-run-card run-${phase}`}
      aria-labelledby={titleId}
      data-run-id={id}
      tabIndex={-1}
    >
      <header className="workflow-run-heading">
        <span className="workflow-run-mark">
          <GitBranch size={18} aria-hidden="true" />
        </span>
        <div className="workflow-run-identity">
          <h2 id={titleId}>第 {index} 次执行</h2>
          <div className="workflow-run-meta">
            {cached ? (
              <time dateTime={new Date(cached.createdAt).toISOString()}>
                {new Date(cached.createdAt).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            ) : (
              <span>正在同步记录</span>
            )}
            {cached ? (
              <span>{cached.mode === "demo" ? "本地演示" : "Codex"}</span>
            ) : null}
          </div>
        </div>
        <span
          className={`workflow-phase workflow-status-badge phase-${phase}`}
          role="status"
        >
          <PhaseIcon
            size={14}
            className={active ? "workflow-spinner" : undefined}
          />
          {workflowPhaseLabels[phase]}
        </span>
        {active ? (
          <button
            type="button"
            className="icon-control workflow-stop"
            aria-label={`停止第 ${index} 次执行`}
            title="停止运行"
            onClick={onCancel}
          >
            <Square size={14} />
          </button>
        ) : null}
      </header>
      {error ? (
        <div className="workflow-fetch-error" role="alert">
          {error}
          <button
            className="text-control"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : null}
      <section className="workflow-run-input" aria-label="本次输入">
        <h3 className="workflow-section-label">
          <ArrowUpRight size={14} />
          输入
        </h3>
        {inputValue === undefined ? (
          <p className="workflow-value-empty">正在读取本次输入…</p>
        ) : (
          <WorkflowData value={inputValue} schema={inputSchema} />
        )}
      </section>
      <section className="workflow-run-output" aria-label="本次输出">
        <h3 className="workflow-section-label">
          <ArrowDownLeft size={14} />
          输出
        </h3>
        {problem ? (
          <div className="workflow-run-problem" role="alert">
            <CircleAlert size={16} />
            <WorkflowRichText text={problem} />
          </div>
        ) : null}
        {hasWorkflowContent(output) && !(problem && output === problem) ? (
          <WorkflowData value={output} />
        ) : (
          <div className="workflow-output-placeholder">
            {active ? (
              <LoaderCircle size={18} className="workflow-spinner" />
            ) : (
              <ArrowDownLeft size={18} />
            )}
            <span>
              {!cached && !savedOutput && !error
                ? "正在读取本次输出…"
                : active
                  ? "工作流正在执行，输出将在这里更新。"
                  : phase === "completed"
                    ? "工作流已完成，但未返回输出内容。"
                    : "本次执行未生成输出，可展开执行过程查看详情。"}
            </span>
          </div>
        )}
        {output !== undefined && !hasWorkflowContent(output) ? (
          <WorkflowJson value={output} />
        ) : null}
      </section>
      <div className="workflow-run-progress" aria-label="执行进度">
        <span className="workflow-current-step">
          {active ? (
            <>
              <span className="workflow-live-dot" />
              {progress.current.length
                ? `正在执行 · ${progress.current.join("、")}`
                : "等待下一步执行"}
            </>
          ) : (
            <>
              <CheckCircle2 size={13} />
              {progress.completed} 个步骤完成
            </>
          )}
        </span>
        {progress.total ? (
          <span className="workflow-progress-count">
            {progress.completed} / {progress.total}
          </span>
        ) : null}
        {cached ? (
          <span className="workflow-run-duration">
            <Clock3 size={12} />
            {workflowDuration(
              cached.createdAt,
              cached.finishedAt ?? Date.now(),
            )}
          </span>
        ) : null}
      </div>
      {cached?.steps.length ? (
        <details className="workflow-execution">
          <summary>执行过程 · {cached.steps.length} 个步骤</summary>
          <div className="workflow-steps">
            {cached.steps.map((step) => (
              <button
                key={step.id}
                className={step.id === stepId ? "selected" : ""}
                aria-expanded={step.id === stepId}
                onClick={() =>
                  setStepId(step.id === stepId ? undefined : step.id)
                }
              >
                <span className="workflow-step-label">
                  <i className={`workflow-step-dot phase-${step.status}`} />
                  {step.label}
                </span>
                <small className={`workflow-phase phase-${step.status}`}>
                  {workflowPhaseLabels[step.status]}
                </small>
              </button>
            ))}
          </div>
          {selected ? (
            <StepHistory
              key={selected.id}
              endpoint={endpoint}
              runId={id}
              step={selected}
            />
          ) : null}
        </details>
      ) : null}
    </article>
  );
}
