import React, { useEffect, useId, useRef, useState } from "react";
import { GitBranch, LoaderCircle, Play, Plus, X } from "lucide-react";
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
import { WorkflowInput, schemaInitialValue } from "./WorkflowInput";
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
  const schema = binding.inputSchema ?? flow?.inputSchema;
  const text =
    workspace.draft ||
    JSON.stringify(
      binding.pending?.input ?? schemaInitialValue(schema),
      null,
      2,
    );
  const [mode, setMode] = useState<FlowMode>(
    workspace.state.provider === "codex" ? "codex" : "demo",
  );
  const [jsonMode, setJsonMode] = useState(false);
  const [inputError, setInputError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const dialogTitle = useId();
  const initiallyEmpty = useRef(
    session.messages.length === 0 && !binding.pending,
  );
  const pending = binding.pending;
  const submitting = workspace.workflows.submitting.includes(session.id);
  const executions = workflowExecutions(session.messages);
  const runCount = executions.filter(
    ({ message }) => message.workflowRunId,
  ).length;
  const error = workspace.workflows.errors[session.id];
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session.messages]);
  useEffect(() => {
    const modal = dialog.current;
    if (initiallyEmpty.current) modal?.showModal();
    return () => modal?.close();
  }, []);
  function openComposer() {
    setInputError("");
    dialog.current?.showModal();
  }
  function closeComposer() {
    dialog.current?.close();
    runButton.current?.focus();
  }
  async function submit(input?: JsonValue, runMode = mode) {
    if (workspace.busy) return;
    try {
      if (input === undefined) input = JSON.parse(text);
    } catch {
      setInputError("请输入有效的 JSON。");
      return;
    }
    setInputError("");
    nearBottom.current = true;
    const accepted = await workspace.workflows.start(
      session.id,
      input!,
      runMode,
    );
    if (accepted) {
      dialog.current?.close();
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
          onClick={openComposer}
          disabled={workspace.busy || flow?.available === false}
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
          {!executions.length && !pending ? (
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
                inputSchema={schema}
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
        </div>
      </div>
      <dialog
        ref={dialog}
        className="workflow-run-dialog"
        aria-labelledby={dialogTitle}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeComposer();
        }}
      >
        <form
          className="workflow-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="workflow-dialog-heading">
            <div>
              <h2 id={dialogTitle}>
                {runCount ? "再次运行工作流" : "运行工作流"}
              </h2>
              <p>{binding.title}</p>
            </div>
            <button
              type="button"
              className="icon-control"
              aria-label="关闭运行输入"
              onClick={closeComposer}
            >
              <X size={18} />
            </button>
          </div>
          {pending && !workspace.busy ? (
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
          ) : null}
          <WorkflowInput
            schema={jsonMode ? undefined : schema}
            text={text}
            disabled={workspace.busy || Boolean(pending)}
            onChange={workspace.setDraft}
          />
          {inputError || error ? (
            <p role="alert" className="error">
              {inputError || error}
            </p>
          ) : null}
          <div className="workflow-compose-actions">
            <select
              aria-label="运行模式"
              value={mode}
              disabled={workspace.busy || Boolean(pending)}
              onChange={(event) => setMode(event.target.value as FlowMode)}
            >
              <option value="demo">本地演示</option>
              <option value="codex">Codex</option>
            </select>
            <button
              type="button"
              className="text-control"
              aria-pressed={jsonMode}
              onClick={() => setJsonMode(!jsonMode)}
            >
              {jsonMode ? "表单输入" : "JSON"}
            </button>
            <span className="workflow-compose-spacer" />
            <button
              className="primary-button"
              type="submit"
              disabled={
                workspace.busy || Boolean(pending) || flow?.available === false
              }
            >
              {submitting ? (
                <LoaderCircle size={14} className="workflow-spinner" />
              ) : (
                <Play size={14} />
              )}
              {submitting ? "提交中…" : "开始执行"}
            </button>
          </div>
          <p className="workflow-compose-note">
            输入与结果将保存在当前会话中。
          </p>
        </form>
      </dialog>
    </section>
  );
}
