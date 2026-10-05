import { providerMode } from "@aura/core";
import React, { useEffect, useId, useRef, useState } from "react";
import { GitBranch, Play, Plus } from "lucide-react";
import type {
  FlowCatalogEntry,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";
import type { WorkspaceController } from "../useWorkspace";
import { workflowRunKey } from "../workflowSessions";
import { videoCompositionResult } from "../videoResult";
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
}: {
  workspace: WorkspaceController;
  flow?: FlowCatalogEntry;
}) {
  const session = workspace.active!;
  const binding = session.workflow!;
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
  const positionedVideo = useRef("");
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
  const latest = executions.at(-1)?.message;
  const latestRun = latest?.workflowRunId
    ? workspace.workflows.runs[
        workflowRunKey(binding.endpoint, latest.workflowRunId)
      ]
    : undefined;
  const latestVideo = latest?.workflowRunId
    ? videoCompositionResult(
        latestRun ? latestRun.output : storedWorkflowValue(latest.text),
      )
    : undefined;
  const videoResultKey = latestVideo ? `${session.id}/${latestVideo.id}` : "";
  const latestRunId = latest?.workflowRunId;
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    if (viewedSession.current !== session.id) {
      viewedSession.current = session.id;
      nearBottom.current = true;
    }
    if (!nearBottom.current) return;
    // A tall completed video result should open at the player, not its footer.
    if (videoResultKey) {
      if (positionedVideo.current === videoResultKey) return;
      const result = container.querySelector<HTMLElement>(
        `[data-run-id="${CSS.escape(latestRunId!)}"] .workflow-message-assistant`,
      );
      if (result) {
        container.scrollTop +=
          result.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        positionedVideo.current = videoResultKey;
        return;
      }
    }
    container.scrollTop = container.scrollHeight;
  }, [session.id, session.messages, videoResultKey, latestRunId]);
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
    <section className="chat-screen workflow-chat" aria-label="工作流会话">
      <header className="chat-title workflow-chat-title">
        <div className="workflow-chat-identity">
          <strong>{session.title}</strong>
          <span
            className="workflow-binding"
            title={`绑定工作流：${binding.title}`}
          >
            <GitBranch size={13} />
            <span>{binding.title}</span>
          </span>
        </div>
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
          {pending ? "检查提交" : runCount ? "再次运行" : "运行工作流"}
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
                <GitBranch size={24} />
              </span>
              <h2>{binding.title}</h2>
              <p>
                {flow?.description ||
                  "每次执行的输入、进度和结果，都会完整保留在这里。"}
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={openComposer}
                disabled={flow?.available === false}
              >
                <Play size={14} />
                填写输入，开始运行
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
                title={binding.title}
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
                aria-label="保留的会话内容"
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
              aria-label="待确认的执行"
            >
              <section className="workflow-message workflow-message-user">
                <div className="workflow-user-bubble">
                  <WorkflowData value={pending.input} schema={schema} />
                </div>
              </section>
              <section className="workflow-message workflow-message-assistant workflow-pending-response">
                <div className="workflow-pending-heading">
                  <GitBranch size={17} />
                  <strong>
                    {submitting ? "正在提交工作流" : "这次执行待确认"}
                  </strong>
                  <span role="status">{submitting ? "提交中" : "待确认"}</span>
                </div>
                <p className="muted">
                  {submitting
                    ? "正在创建本次执行记录…"
                    : "服务尚未确认提交结果。重试会继续确认同一次执行。"}
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
                    重试提交
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
            <p className="workflow-session-note">
              此工作流当前不可运行，历史记录仍可查看。
            </p>
          ) : null}
          {composerOpen ? (
            <WorkflowRunForm
              ref={composer}
              id={composerId}
              title={runCount ? "再次运行工作流" : "运行工作流"}
              subtitle={binding.title}
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
                    上次提交尚未确认，重试会继续同一次运行。
                    <button
                      type="button"
                      className="text-control"
                      onClick={() => void submit(pending.input, pending.mode)}
                    >
                      重试提交
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
