import { providerMode } from "@aura/core";
import { flowTitle, flowDescription } from "../metadata.ts";
import React, { useEffect, useId, useRef, useState } from "react";
import { useWorkflowMessages } from "../workflow-messages.ts";
import { MessageCircle, Play, Plus } from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import type {
  FlowCatalogEntry,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";
import type { WorkspaceController } from "../useWorkspace";
import { workflowRunKey } from "../workflowSessions";
import {
  storedWorkflowValue,
  workflowExecutions,
} from "../workflowPresentation";
import { schemaInitialValue } from "./WorkflowInput";
import { WorkflowRunForm } from "./WorkflowRunForm";
import { WorkflowRunResult } from "./WorkflowRun";
import { WorkflowData } from "./WorkflowValue";

export function WorkflowChat({
  workspace,
  flow,
  onContinue,
}: {
  workspace: WorkspaceController;
  flow?: FlowCatalogEntry;
  onContinue?(): void;
}) {
  const { t } = useWorkflowMessages();
  const session = workspace.active!;
  const binding = session.workflow!;
  const displayTitle =
    flow && binding.title === flow.title ? flowTitle(flow) : binding.title;
  const schema =
    flow?.available && flow.inputSchema
      ? flow.inputSchema
      : (binding.inputSchema ?? flow?.inputSchema);
  const text =
    workspace.draft ||
    JSON.stringify(
      binding.pending?.input ?? schemaInitialValue(schema),
      null,
      2,
    );
  const [mode, setMode] = useState<FlowMode>(
    providerMode(workspace.state.provider),
  );
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const viewedSession = useRef(session.id);
  const composer = useRef<HTMLFormElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const composerId = useId();
  const [composerSessionId, setComposerSessionId] = useState<string | null>(
    session.messages.length === 0 && !binding.pending ? session.id : null,
  );
  const composerOpen = composerSessionId === session.id;
  const pending = binding.pending;
  const submitting = workspace.workflows.submitting.includes(session.id);
  const executions = workflowExecutions(session.messages);
  const runCount = executions.filter(
    ({ message }) => message.workflowRunId,
  ).length;
  const error = workspace.workflows.errors[session.id];
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    if (viewedSession.current !== session.id) {
      viewedSession.current = session.id;
      nearBottom.current = true;
    }
    if (!nearBottom.current) return;
    container.scrollTop = container.scrollHeight;
  }, [session.id, session.messages]);
  useEffect(() => {
    if (session.messages.length === 0 && !binding.pending)
      setComposerSessionId(session.id);
  }, [binding.pending, session.id, session.messages.length]);
  function openComposer() {
    nearBottom.current = true;
    setComposerSessionId(session.id);
  }
  function closeComposer() {
    setComposerSessionId(null);
    runButton.current?.focus();
  }
  async function submit(input: JsonValue, runMode = mode) {
    if (workspace.busy) return;
    nearBottom.current = true;
    const accepted = await workspace.workflows.start(
      session.id,
      input,
      runMode,
    );
    if (accepted) {
      setComposerSessionId(null);
      requestAnimationFrame(() =>
        scroll.current
          ?.querySelector<HTMLElement>(
            `[data-run-id="${CSS.escape(accepted)}"]`,
          )
          ?.focus(),
      );
    }
  }
  let executionIndex = 0;
  return (
    <section
      className="chat-screen workflow-chat"
      aria-label={t("workflowConversation")}
    >
      <header className="chat-title workflow-chat-title">
        <div className="workflow-chat-identity">
          <strong>{session.title}</strong>
          <span
            className="workflow-binding"
            title={t("boundWorkflow", { title: displayTitle })}
          >
            <FlowIcon size={13} />
            <span>{displayTitle}</span>
          </span>
        </div>
        {onContinue ? (
          <button
            type="button"
            className="tool-button"
            onClick={onContinue}
            disabled={
              Boolean(pending) || submitting || Boolean(session.archivedAt)
            }
          >
            <MessageCircle size={14} />
            {t("continueConversation")}
          </button>
        ) : null}
        <button
          ref={runButton}
          type="button"
          className="tool-button workflow-new-run"
          onClick={composerOpen ? closeComposer : openComposer}
          disabled={workspace.busy || flow?.available === false}
          aria-expanded={composerOpen}
          aria-controls={composerId}
        >
          <Plus size={14} />
          {pending
            ? t("checkSubmission")
            : runCount
              ? t("runAgain")
              : t("runWorkflow")}
        </button>
      </header>
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el)
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        <div className="workflow-conversation">
          {!executions.length && !pending && !composerOpen ? (
            <div className="workflow-chat-empty">
              <span className="workflow-empty-icon">
                <FlowIcon size={24} />
              </span>
              <h2>{displayTitle}</h2>
              <p>{(flow && flowDescription(flow)) || t("conversationHint")}</p>
              <button
                type="button"
                className="primary-button"
                onClick={openComposer}
                disabled={flow?.available === false}
              >
                <Play size={14} />
                {t("fillInputStart")}
              </button>
            </div>
          ) : null}
          {executions.map(({ message, input }) =>
            message.workflowRunId ? (
              <WorkflowRunResult
                key={message.id}
                endpoint={binding.endpoint}
                message={message}
                input={input}
                index={++executionIndex}
                title={displayTitle}
                inputSchema={binding.inputSchema ?? schema}
                cached={
                  workspace.workflows.runs[
                    workflowRunKey(binding.endpoint, message.workflowRunId)
                  ]
                }
                receive={workspace.workflows.receive}
                onCancel={() => void workspace.workflows.cancel(session.id)}
              />
            ) : (
              <article
                className={`workflow-message workflow-legacy-record ${
                  message.role === "user"
                    ? "workflow-message-user"
                    : "workflow-message-assistant"
                }`}
                key={message.id}
                aria-label={t("retainedConversation")}
              >
                <div
                  className={
                    message.role === "user" ? "workflow-user-bubble" : undefined
                  }
                >
                  <WorkflowData value={storedWorkflowValue(message.text)} />
                </div>
              </article>
            ),
          )}
          {pending ? (
            <article
              className="workflow-turn workflow-pending-turn"
              aria-label={t("unconfirmedRun")}
            >
              <section className="workflow-message workflow-message-user">
                <div className="workflow-user-bubble">
                  <WorkflowData value={pending.input} schema={schema} />
                </div>
              </section>
              <section className="workflow-message workflow-message-assistant workflow-pending-response">
                <div className="workflow-pending-heading">
                  <FlowIcon size={17} />
                  <strong>
                    {submitting ? t("submittingWorkflow") : t("runPending")}
                  </strong>
                  <span role="status">
                    {submitting ? t("submitting") : t("pendingConfirmation")}
                  </span>
                </div>
                <p className="muted">
                  {submitting
                    ? t("creatingRecord")
                    : t("submissionUnconfirmed")}
                </p>
                {error ? (
                  <p role="alert" className="error">
                    {error}
                  </p>
                ) : null}
                {!submitting ? (
                  <button
                    type="button"
                    className="tool-button"
                    onClick={() => void submit(pending.input, pending.mode)}
                  >
                    {t("retrySubmission")}
                  </button>
                ) : null}
              </section>
            </article>
          ) : error ? (
            <p className="workflow-session-error error" role="alert">
              {error}
            </p>
          ) : null}
          {flow?.available === false ? (
            <p className="workflow-session-note">{t("unavailableHistory")}</p>
          ) : null}
          {composerOpen ? (
            <WorkflowRunForm
              ref={composer}
              id={composerId}
              title={runCount ? t("runWorkflowAgain") : t("runWorkflow")}
              subtitle={displayTitle}
              schema={schema}
              text={text}
              onTextChange={workspace.setDraft}
              endpoint={binding.endpoint}
              initialMode={mode}
              locked={workspace.busy || Boolean(pending)}
              submitting={submitting}
              unavailable={flow?.available === false}
              error={error}
              notice={
                pending && !workspace.busy ? (
                  <div className="workflow-pending" role="status">
                    {t("previousUnconfirmed")}
                    <button
                      type="button"
                      className="text-control"
                      onClick={() => void submit(pending.input, pending.mode)}
                    >
                      {t("retrySubmission")}
                    </button>
                  </div>
                ) : null
              }
              onSubmit={(input, runMode) => {
                setMode(runMode);
                void submit(input, runMode);
              }}
              onClose={closeComposer}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
