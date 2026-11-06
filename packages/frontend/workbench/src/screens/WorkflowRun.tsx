import React, { useEffect, useId, useState } from "react";
import { apiErrorText, flowFailureText } from "../api-error-messages.ts";
import {
  useWorkflowMessages,
  workflowMessage as localMessage,
  workflowModeText,
  workflowPhaseText,
} from "../workflow-messages.ts";
import {
  errorMessage,
  messageText,
  formatDate,
  formatNumber,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import { useWorkflowRun } from "../useWorkflowRun";
import { workflowRuns } from "../workflow-run-store";
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
  workflowApi,
  workflowPhaseLabels,
} from "../workflowSessions";

/**
 * When the run produced playable or viewable files, those are the result; an
 * output that only restates their local paths folds into a details row.
 */
function RunOutput({ value }: { value: JsonValue }) {
  const { t } = useWorkflowMessages();
  const hasArtifacts = useHasArtifacts();
  if (hasArtifacts && onlyFileReferences(value))
    return (
      <details className="workflow-output-details">
        <summary>{t("fileLocations")}</summary>
        <WorkflowData value={value} />
      </details>
    );
  return <WorkflowData value={value} />;
}

export function NestedFlowRun({
  endpoint,
  runId,
  onRepeat,
}: {
  endpoint: string;
  runId: string;
  onRepeat?(run: FlowRun): void;
}) {
  const { t, i18n } = useWorkflowMessages();
  const { run, error } = useWorkflowRun(endpoint, runId);
  const [actionError, setActionError] = useState<string | MessageReference>("");
  const [cancelRequestId] = useState(() => crypto.randomUUID());
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!run) return <p className="muted">{t("loadingRun")}</p>;
  return (
    <>
      {actionError ? (
        <p className="error" role="alert">
          {messageText(actionError, i18n)}
        </p>
      ) : null}
      <WorkflowRunResult
        endpoint={endpoint}
        cached={run}
        message={{
          id: run.id,
          role: "assistant",
          text: "",
          status: "complete",
          workflowRunId: run.id,
        }}
        title={run.flow.title}
        receive={(source, next) => workflowRuns.publish(source, next)}
        onRepeat={onRepeat}
        onCancel={() => {
          setActionError("");
          void workflowApi<FlowRun>(
            endpoint,
            `/runs/${encodeURIComponent(run.id)}/cancel`,
            { requestId: cancelRequestId },
          )
            .then((next) => workflowRuns.publish(endpoint, next))
            .catch((cause: unknown) =>
              setActionError(errorMessage(cause, localMessage("cancelFailed"))),
            );
        }}
      />
    </>
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
  const { t, i18n } = useWorkflowMessages();
  const [history, setHistory] = useState<FlowHistory>();
  const [error, setError] = useState<string | MessageReference>("");
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
        if (!abort.signal.aborted)
          setError(errorMessage(cause, localMessage("historyFailed")));
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
      setError(errorMessage(cause, localMessage("historyFailed")));
    } finally {
      setBusy(false);
    }
  }
  const selectedAttempt = step.attempts?.find(
    (value) => value.number === attempt,
  );
  return (
    <div className="workflow-step-detail">
      <WorkflowArtifactGallery
        runId={runId}
        stepKey={step.stepKey ?? step.id}
        attempt={attempt}
      />
      {step.error ? (
        <p className="workflow-step-error" role="alert">
          {messageText(flowFailureText(step.error, step.errorDetails), i18n)}
        </p>
      ) : null}
      {step.scopePath?.length || (step.attempts?.length ?? 0) > 1 ? (
        <div className="workflow-step-meta">
          {step.scopePath?.length ? (
            <code title={t("executionPath")}>{step.stepKey}</code>
          ) : null}
          {(step.attempts?.length ?? 0) > 1 ? (
            <div
              className="workflow-step-attempts"
              role="radiogroup"
              aria-label={t("attempts")}
            >
              {step.attempts!.map((value) => (
                <button
                  key={value.number}
                  type="button"
                  role="radio"
                  aria-checked={attempt === value.number}
                  className={`phase-${value.status}${attempt === value.number ? " selected" : ""}`}
                  title={workflowPhaseText(value.status, t)}
                  onClick={() => {
                    setHistory(undefined);
                    setAttempt(value.number);
                  }}
                >
                  {t("attemptNumber", { number: value.number })}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!step.kind || step.kind === "agent" ? (
        step.config ? (
          <section aria-label={t("agentConfiguration")}>
            <h4>{t("agentConfiguration")}</h4>
            <WorkflowData
              value={{
                [t("provider")]: step.config.provider,
                [t("model")]: step.config.model,
                [t("reasoningEffort")]: step.config.reasoningEffort,
                [t("maxOutputTokens")]:
                  step.config.maxTokens ?? t("providerDefaultUnlimited"),
                [t("temperature")]:
                  step.config.temperature ?? t("providerDefault"),
                [t("timeoutMs")]: step.config.timeoutMs,
              }}
            />
            <p className="muted">{t("archivedConfig")}</p>
          </section>
        ) : (
          <p className="muted">{t("legacyNoConfig")}</p>
        )
      ) : null}
      {selectedAttempt?.error ? (
        <p className="workflow-step-error">
          {messageText(
            flowFailureText(
              selectedAttempt.error,
              selectedAttempt.errorDetails,
            ),
            i18n,
          )}
        </p>
      ) : null}
      {step.recoveryEvents?.map((event, index) => (
        <p className="muted workflow-recovery-event" key={index}>
          {formatDate(event.at, { dateStyle: "short", timeStyle: "medium" })} ·{" "}
          {messageText(apiErrorText(event.reasonDetails, event.reason), i18n)}
        </p>
      ))}
      {step.kind && step.kind !== "agent" ? (
        step.kind === "flow" ? (
          <>
            <h4>{t("childInput")}</h4>
            <WorkflowData value={step.input} />
            <p className="muted">{t("childWorkflow", { id: step.flowId })}</p>
            {step.childRunId ? (
              <NestedFlowRun endpoint={endpoint} runId={step.childRunId} />
            ) : (
              <p className="muted">{t("creatingChild")}</p>
            )}
            {step.output !== undefined ? (
              <>
                <h4>{t("childOutput")}</h4>
                <WorkflowData value={step.output} />
              </>
            ) : null}
          </>
        ) : (
          <div
            className={`workflow-step-io${step.kind === "action" ? "" : " single"}`}
          >
            {step.kind === "action" ? (
              <section
                className="workflow-step-panel"
                aria-label={t("toolInput")}
              >
                <h4>{t("input")}</h4>
                <WorkflowData value={step.input} />
              </section>
            ) : null}
            <section
              className="workflow-step-panel"
              aria-label={
                step.kind === "checkpoint"
                  ? t("submittedAnswer")
                  : t("stepOutput")
              }
            >
              <h4>
                {step.kind === "checkpoint"
                  ? t("submittedAnswer")
                  : t("output")}
              </h4>
              {step.output === undefined ? (
                <p className="muted">{t("waitingOutput")}</p>
              ) : (
                <WorkflowData value={step.output} />
              )}
            </section>
          </div>
        )
      ) : (
        <>
          <div className="workflow-history-actions">
            <span>{t("agentHistory")}</span>
            <button
              className="icon-control"
              aria-label={t("refreshStepHistory")}
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
              {t("loadOlderHistory")}
            </button>
          ) : null}
          {history?.entries.map((entry) => (
            <div className="workflow-history-entry" key={entry.seq}>
              <small>
                {
                  {
                    user: t("input"),
                    assistant: t("agentReply"),
                    tool: t("toolResult"),
                    event: t("executionEvent"),
                  }[entry.kind]
                }
              </small>
              <WorkflowRichText text={entry.text} />
            </div>
          ))}
          {!history?.entries.length ? (
            <p className="muted">{busy ? t("reading") : t("noHistory")}</p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="error">
          {messageText(error, i18n)}
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
  cached: previous,
  receive,
  input,
  index,
  inputSchema,
  title,
  onCancel,
  onRepeat,
}: {
  endpoint: string;
  /** Flow name shown when the run lives in an ordinary conversation. */
  title?: string;
  message: Message;
  cached?: FlowRun;
  receive(endpoint: string, run: FlowRun): void;
  input?: Message;
  index?: number;
  inputSchema?: JsonValue;
  onCancel(): void;
  onRepeat?(run: FlowRun): void;
}) {
  const { t, i18n } = useWorkflowMessages();
  const [stepId, setStepId] = useState<string>();
  const results = usePluginResults();
  const id = message.workflowRunId!;
  const titleId = useId();
  const { run: observed, error, refresh } = useWorkflowRun(endpoint, id);
  const cached = observed ?? previous;
  useEffect(() => {
    if (observed) receive(endpoint, observed);
  }, [endpoint, observed, receive]);
  const phase = cached?.status ?? message.workflowPhase ?? "queued";
  const active = isWorkflowActive(phase);
  const progress = workflowProgress(cached);
  const inputValue = cached
    ? cached.input
    : input
      ? storedWorkflowValue(input.text)
      : undefined;
  // Legacy records contain these exact status strings; UI language must not change the match.
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
  const problem = cached?.error
    ? messageText(flowFailureText(cached.error, cached.errorDetails), i18n)
    : phase === "failed" && !cached
      ? message.text
      : undefined;
  const PhaseIcon =
    phase === "completed" ? CheckCircle2 : active ? LoaderCircle : CircleAlert;
  const steps = cached?.steps.length ? (
    <ol className="workflow-stream-steps" aria-label={t("executionSteps")}>
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
                <small>{workflowPhaseText(step.status, t)}</small>
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
      {t("preparingSteps")}
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
          aria-label={t("runInput")}
        >
          <div className="workflow-user-bubble">
            {inputValue === undefined ? (
              <p className="workflow-value-empty">{t("loadingRunInput")}</p>
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
                <strong id={titleId}>{title ?? t("workflow")}</strong>
                {index ? (
                  <span className="workflow-run-number">
                    {t("runNumber", { number: index })}
                  </span>
                ) : null}
              </div>
              <div className="workflow-run-meta">
                {cached ? (
                  <time dateTime={new Date(cached.createdAt).toISOString()}>
                    {formatDate(cached.createdAt, {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                ) : (
                  <span>{t("syncingRecord")}</span>
                )}
                {cached ? (
                  <span>{workflowModeText(cached.mode, t)}</span>
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
              {workflowPhaseText(phase, t)}
            </span>
            {active ? (
              <button
                type="button"
                className="icon-control workflow-stop"
                aria-label={
                  index
                    ? t("stopNumberedRun", { number: index })
                    : t("stopWorkflow")
                }
                title={t("stopRun")}
                onClick={onCancel}
              >
                <Square size={14} />
              </button>
            ) : null}
          </header>
          {error ? (
            <div className="workflow-fetch-error" role="alert">
              {error}
              <button className="text-control" onClick={refresh}>
                {t("retry")}
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
            <section
              className="workflow-stream-output"
              aria-label={t("runOutput")}
            >
              <WorkflowArtifactGallery />
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
                          ? t("loadingRunContent")
                          : active
                            ? t("stepsRunning")
                            : phase === "completed"
                              ? t("completedNoOutput")
                              : t("runNoOutput")}
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
          <footer
            className="workflow-response-meta"
            aria-label={t("executionProgress")}
          >
            {onRepeat && cached ? (
              <button
                type="button"
                className="tool-button"
                disabled={active}
                onClick={() => onRepeat(cached)}
              >
                <RefreshCw size={14} />
                {t("runAgain")}
              </button>
            ) : null}
            <span className="workflow-current-step">
              {active ? (
                <>
                  <span className="workflow-live-dot" />
                  {progress.current.length
                    ? t("runningSteps", {
                        steps: new Intl.ListFormat(i18n.language, {
                          style: "short",
                          type: "conjunction",
                        }).format(progress.current),
                      })
                    : t("waitingNextStep")}
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} />
                  {t("completedSteps", { count: progress.completed })}
                </>
              )}
            </span>
            {progress.total ? (
              <span className="workflow-progress-count">
                {formatNumber(progress.completed)} /{" "}
                {formatNumber(progress.total)}
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
