import React, { useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { FlowHistory, FlowRun, FlowStep } from "@aura/protocol/types";
import type { Message } from "@aura/core/types";
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
          <strong>输入</strong>
          <pre>{JSON.stringify(step.input, null, 2)}</pre>
          <strong>输出</strong>
          <pre>{JSON.stringify(step.output, null, 2) ?? "等待输出"}</pre>
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
              <small>{entry.kind}</small>
              <p>{entry.text}</p>
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
}: {
  endpoint: string;
  message: Message;
  cached?: FlowRun;
  receive(endpoint: string, run: FlowRun): void;
}) {
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [stepId, setStepId] = useState<string>();
  const id = message.workflowRunId!;
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
  return (
    <article className="chat-message from-assistant workflow-result">
      <div className="message-author">
        <GitBranch size={18} aria-label="工作流消息" />
        <strong>工作流</strong>
        <span className={`workflow-phase phase-${phase}`} role="status">
          {workflowPhaseLabels[phase]}
        </span>
        {cached?.mode === "demo" ? <small className="muted">演示</small> : null}
      </div>
      <div className={`message-body${phase === "failed" ? " error" : ""}`}>
        {message.text}
      </div>
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
      {cached?.output !== undefined ? (
        <details className="workflow-execution">
          <summary>完整输出</summary>
          <pre className="workflow-raw-output">
            {JSON.stringify(cached.output, null, 2)}
          </pre>
        </details>
      ) : null}
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
                <span>{step.label}</span>
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
