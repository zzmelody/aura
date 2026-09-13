import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, GitBranch, Square } from "lucide-react";
import type {
  FlowCatalogEntry,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";
import type { WorkspaceController } from "../useWorkspace";
import { workflowRunKey } from "../workflowSessions";
import { WorkflowInput, schemaInitialValue } from "./WorkflowInput";
import { WorkflowRunResult } from "./WorkflowRun";

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
  const pending = binding.pending;
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session.messages]);
  async function submit() {
    if (workspace.busy) return;
    let input: JsonValue;
    try {
      input = JSON.parse(text);
    } catch {
      setInputError("请输入有效的 JSON。");
      return;
    }
    setInputError("");
    nearBottom.current = true;
    await workspace.workflows.start(session.id, input, mode);
  }
  return (
    <section className="chat-screen workflow-chat" aria-label="工作流会话">
      <header className="chat-title">
        <strong>{session.title}</strong>
        <span
          className="workflow-binding"
          title={`绑定工作流：${binding.title}`}
        >
          <GitBranch size={14} />
          <span>工作流 · {binding.title}</span>
        </span>
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
          {!session.messages.length ? (
            <div className="workflow-chat-empty">
              <span className="workflow-empty-icon">
                <GitBranch size={24} />
              </span>
              <h2>{binding.title}</h2>
              <p>
                {flow?.description ||
                  "填写本次输入，工作流的执行过程和结果会保留在这个会话中。"}
              </p>
            </div>
          ) : null}
          {session.messages.map((message) =>
            message.workflowRunId ? (
              <WorkflowRunResult
                key={message.id}
                endpoint={binding.endpoint}
                message={message}
                cached={
                  workspace.workflows.runs[
                    workflowRunKey(binding.endpoint, message.workflowRunId)
                  ]
                }
                receive={workspace.workflows.receive}
              />
            ) : (
              <article className="chat-message from-user" key={message.id}>
                <div className="message-body">{message.text}</div>
              </article>
            ),
          )}
        </div>
      </div>
      <div className="workflow-compose-wrap">
        <form
          className="workflow-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {pending && !workspace.busy ? (
            <div className="workflow-pending" role="status">
              上次提交尚未确认，重试会继续同一次运行。
              <button
                type="button"
                className="text-control"
                onClick={() =>
                  void workspace.workflows.start(
                    session.id,
                    pending.input,
                    pending.mode,
                  )
                }
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
          {inputError || workspace.workflows.errors[session.id] ? (
            <p role="alert" className="error">
              {inputError || workspace.workflows.errors[session.id]}
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
            {workspace.busy ? (
              <button
                type="button"
                className="tool-button"
                disabled={workspace.workflows.submitting.includes(session.id)}
                onClick={() => void workspace.workflows.cancel(session.id)}
              >
                <Square size={13} />
                {workspace.workflows.submitting.includes(session.id)
                  ? "提交中…"
                  : "停止运行"}
              </button>
            ) : (
              <button
                className="primary-button"
                type="submit"
                disabled={Boolean(pending) || flow?.available === false}
              >
                <ArrowUp size={15} />
                运行工作流
              </button>
            )}
          </div>
        </form>
        <p className="workflow-compose-note">
          {flow?.available === false
            ? "此工作流当前不可运行，历史记录仍可查看。"
            : "每次运行都会使用新的输入，结果保存在当前会话。"}
        </p>
      </div>
    </section>
  );
}
