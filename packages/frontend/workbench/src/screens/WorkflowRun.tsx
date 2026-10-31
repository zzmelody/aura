import React, { useEffect, useId, useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  GitFork,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import { AuraMark } from "@aura/ui/components";
import type {
  FlowHistory,
  FlowRun,
  FlowStep,
  JsonValue,
} from "@aura/protocol/types";
import type { Message } from "@aura/core/types";
import {
  hasWorkflowContent,
  onlyFileReferences,
  storedWorkflowValue,
  workflowDuration,
  workflowProgress,
} from "../workflowPresentation";
import { WorkflowData, WorkflowJson, WorkflowRichText } from "./WorkflowValue";
import {
  WorkflowArtifactProvider,
  WorkflowArtifactGallery,
  useHasArtifacts,
} from "./WorkflowArtifacts";
import { WorkflowControls } from "./WorkflowControls";
import {
  matchPluginResult,
  PluginResultBoundary,
  usePluginResults,
} from "../pluginResults";
import {
  isWorkflowActive,
  isWorkflowOpen,
  workflowApi,
  workflowPhaseLabels,
} from "../workflowSessions";

/**
 * When the run produced playable or viewable files, those are the result; an
 * output that only restates their local paths folds into a details row.
 */
function RunOutput({ value }: { value: JsonValue }) {
  const hasArtifacts = useHasArtifacts();
  if (hasArtifacts && onlyFileReferences(value))
    return (
      <details className="workflow-output-details">
        <summary>文件位置与原始数据</summary>
        <WorkflowData value={value} />
      </details>
    );
  return <WorkflowData value={value} />;
}

export function NestedFlowRun({
  endpoint,
  runId,
}: {
  endpoint: string;
  runId: string;
}) {
  const [run, setRun] = useState<FlowRun>();
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await workflowApi<FlowRun>(
          endpoint,
          `/runs/${encodeURIComponent(runId)}`,
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setRun(next);
        setError("");
        if (isWorkflowOpen(next.status)) timer = setTimeout(poll, 1200);
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "子工作流读取失败");
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, runId]);
  if (error) return <p className="error">{error}</p>;
  if (!run) return <p className="muted">正在读取子工作流…</p>;
  return (
    <section
      className="workflow-child-run"
      aria-label={`子工作流 ${run.flow.title}`}
    >
      <header>
        <span className="workflow-child-icon" aria-hidden="true">
          <GitFork size={14} />
        </span>
        <div>
          <strong>{run.flow.title}</strong>
          <small>{run.flow.id}</small>
        </div>
        <span className={`workflow-phase phase-${run.status}`}>
          {workflowPhaseLabels[run.status]}
        </span>
      </header>
      <WorkflowControls
        endpoint={endpoint}
        run={run}
        receive={(_endpoint, next) => setRun(next)}
      />
      {run.steps.length ? (
        <div className="workflow-child-steps">
          {run.steps.map((step) => (
            <details key={step.stepKey ?? step.id}>
              <summary>
                <StepStateIcon status={step.status} />
                <span>{step.label}</span>
                <small>{workflowPhaseLabels[step.status]}</small>
              </summary>
              <StepHistory endpoint={endpoint} runId={run.id} step={step} />
            </details>
          ))}
        </div>
      ) : (
        <p className="muted">尚未创建执行步骤</p>
      )}
    </section>
  );
}

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
  const [attempt, setAttempt] = useState(step.attempts?.at(-1)?.number);
  const path = `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.stepKey ?? step.id)}/history${attempt ? `?attempt=${attempt}` : ""}`;
  useEffect(() => {
    if (step.kind && step.kind !== "agent") return;
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
        `${path}${path.includes("?") ? "&" : "?"}beforeSeq=${before}`,
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
      <WorkflowArtifactGallery
        runId={runId}
        stepKey={step.stepKey ?? step.id}
        attempt={attempt}
      />
      {step.error ? (
        <p className="workflow-step-error" role="alert">
          {step.error}
        </p>
      ) : null}
      {step.scopePath?.length || (step.attempts?.length ?? 0) > 1 ? (
        <div className="workflow-step-meta">
          {step.scopePath?.length ? (
            <code title="执行路径">{step.stepKey}</code>
          ) : null}
          {(step.attempts?.length ?? 0) > 1 ? (
            <div
              className="workflow-step-attempts"
              role="radiogroup"
              aria-label="执行尝试"
            >
              {step.attempts!.map((value) => (
                <button
                  key={value.number}
                  type="button"
                  role="radio"
                  aria-checked={attempt === value.number}
                  className={`phase-${value.status}${attempt === value.number ? " selected" : ""}`}
                  title={workflowPhaseLabels[value.status]}
                  onClick={() => {
                    setHistory(undefined);
                    setAttempt(value.number);
                  }}
                >
                  第 {value.number} 次
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!step.kind || step.kind === "agent" ? (
        step.config ? (
          <section aria-label="Agent 生效配置">
            <h4>Agent 生效配置</h4>
            <WorkflowData
              value={{
                Provider: step.config.provider,
                模型: step.config.model,
                思考强度: step.config.reasoningEffort,
                "输出 token 上限":
                  step.config.maxTokens ?? "供应商默认（未设置硬上限）",
                温度: step.config.temperature ?? "供应商默认",
                "超时（毫秒）": step.config.timeoutMs,
              }}
            />
            <p className="muted">已存档；本步骤的重试和恢复均使用此配置。</p>
          </section>
        ) : (
          <p className="muted">旧记录未存档模型配置。</p>
        )
      ) : null}
      {step.attempts?.find((value) => value.number === attempt)?.error ? (
        <p className="workflow-step-error">
          {step.attempts.find((value) => value.number === attempt)?.error}
        </p>
      ) : null}
      {step.recoveryEvents?.map((event, index) => (
        <p className="muted" key={index}>
          {new Date(event.at).toLocaleString()} · {event.reason}
        </p>
      ))}
      {step.kind && step.kind !== "agent" ? (
        step.kind === "flow" ? (
          <>
            <h4>子工作流输入</h4>
            <WorkflowData value={step.input} />
            <p className="muted">
              固定版本 {step.sourceHash.slice(0, 10)} · {step.flowId}
            </p>
            {step.childRunId ? (
              <NestedFlowRun endpoint={endpoint} runId={step.childRunId} />
            ) : (
              <p className="muted">正在创建子工作流运行…</p>
            )}
            {step.output !== undefined ? (
              <>
                <h4>子工作流输出</h4>
                <WorkflowData value={step.output} />
              </>
            ) : null}
          </>
        ) : (
          <div
            className={`workflow-step-io${step.kind === "action" ? "" : " single"}`}
          >
            {step.kind === "action" ? (
              <section className="workflow-step-panel" aria-label="工具输入">
                <h4>输入</h4>
                <WorkflowData value={step.input} />
              </section>
            ) : null}
            <section
              className="workflow-step-panel"
              aria-label={
                step.kind === "checkpoint" ? "已提交答案" : "步骤输出"
              }
            >
              <h4>{step.kind === "checkpoint" ? "已提交答案" : "输出"}</h4>
              {step.output === undefined ? (
                <p className="muted">等待输出</p>
              ) : (
                <WorkflowData value={step.output} />
              )}
            </section>
          </div>
        )
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

function StepStateIcon({ status }: { status: FlowStep["status"] }) {
  if (status === "completed") return <CheckCircle2 size={14} />;
  if (status === "running")
    return <LoaderCircle size={14} className="workflow-spinner" />;
  if (status === "failed" || status === "unknown")
    return <CircleAlert size={14} />;
  return <Circle size={14} />;
}

export function WorkflowRunResult({
  endpoint,
  message,
  cached,
  receive,
  input,
  index,
  inputSchema,
  title,
  onCancel,
}: {
  endpoint: string;
  /** Flow name shown when the run lives in an ordinary conversation. */
  title?: string;
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
  const results = usePluginResults();
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
        if (isWorkflowOpen(run.status)) timer = setTimeout(poll, 1800);
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
  const pluginResult =
    output !== undefined
      ? matchPluginResult(results, {
          endpoint,
          run: {
            id,
            flowId: cached?.flow.id ?? message.workflow?.id ?? "",
            ...(cached?.flow.plugin
              ? { flowPluginId: cached.flow.plugin.id }
              : {}),
            status: phase,
            ...(inputValue !== undefined ? { input: inputValue } : {}),
          },
          output,
        })
      : undefined;
  const problem =
    cached?.error ?? (phase === "failed" && !cached ? message.text : undefined);
  const PhaseIcon =
    phase === "completed" ? CheckCircle2 : active ? LoaderCircle : CircleAlert;
  const steps = cached?.steps.length ? (
    <ol className="workflow-stream-steps" aria-label="执行步骤">
      {cached.steps.map((step) => {
        const key = step.stepKey ?? step.id;
        const expanded = key === stepId;
        return (
          <li className={`phase-${step.status}`} key={key}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setStepId(expanded ? undefined : key)}
            >
              <span className="workflow-step-state" aria-hidden="true">
                <StepStateIcon status={step.status} />
              </span>
              <span className="workflow-step-copy">
                <strong>{step.label}</strong>
                <small>{workflowPhaseLabels[step.status]}</small>
              </span>
            </button>
            {expanded ? (
              <StepHistory
                key={key}
                endpoint={endpoint}
                runId={id}
                step={step}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  ) : active ? (
    <div className="workflow-stream-starting">
      <LoaderCircle size={15} className="workflow-spinner" />
      正在准备执行步骤…
    </div>
  ) : null;
  return (
    <WorkflowArtifactProvider
      key={`${endpoint}/${id}`}
      endpoint={endpoint}
      runId={id}
      phase={phase}
    >
      <article
        className={`workflow-turn run-${phase}`}
        aria-labelledby={titleId}
        data-run-id={id}
        tabIndex={-1}
      >
        <section
          className="workflow-message workflow-message-user"
          aria-label="本次输入"
        >
          <div className="workflow-user-bubble">
            {inputValue === undefined ? (
              <p className="workflow-value-empty">正在读取本次输入…</p>
            ) : (
              <WorkflowData value={inputValue} schema={inputSchema} />
            )}
          </div>
        </section>
        <section className="workflow-message workflow-message-assistant">
          <header className="workflow-response-heading">
            <span className="workflow-response-mark" aria-hidden="true">
              <AuraMark size={20} />
            </span>
            <div className="workflow-response-identity">
              <div>
                <strong id={titleId}>{title ?? "工作流"}</strong>
                <span className="workflow-run-number">第 {index} 次执行</span>
              </div>
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
          {cached ? (
            <WorkflowControls
              endpoint={endpoint}
              run={cached}
              receive={receive}
            />
          ) : null}
          <div
            className="workflow-stream"
            aria-live={active ? "polite" : "off"}
          >
            {steps}
            <section className="workflow-stream-output" aria-label="本次输出">
              {problem ? (
                <div className="workflow-run-problem" role="alert">
                  <CircleAlert size={16} />
                  <WorkflowRichText text={problem} />
                </div>
              ) : null}
              {pluginResult ? (
                <PluginResultBoundary
                  key={
                    pluginResult.result.pluginId +
                    pluginResult.result.definition.id
                  }
                  render={() =>
                    pluginResult.result.definition.render(pluginResult.context)
                  }
                  fallback={<RunOutput value={output!} />}
                />
              ) : (
                <>
                  {hasWorkflowContent(output) &&
                  !(problem && output === problem) ? (
                    <RunOutput value={output!} />
                  ) : (
                    <div className="workflow-output-placeholder">
                      {active ? (
                        <LoaderCircle size={16} className="workflow-spinner" />
                      ) : (
                        <FlowIcon size={16} />
                      )}
                      <span>
                        {!cached && !savedOutput && !error
                          ? "正在读取执行内容…"
                          : active
                            ? "步骤正在执行，结果会继续显示在这里。"
                            : phase === "completed"
                              ? "工作流已完成，但未返回输出内容。"
                              : "本次执行未生成输出。"}
                      </span>
                    </div>
                  )}
                  {output !== undefined && !hasWorkflowContent(output) ? (
                    <WorkflowJson value={output} />
                  ) : null}
                </>
              )}
            </section>
          </div>
          <footer className="workflow-response-meta" aria-label="执行进度">
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
          </footer>
        </section>
      </article>
    </WorkflowArtifactProvider>
  );
}
