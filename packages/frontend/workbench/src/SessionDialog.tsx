import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { WorkspaceController } from "./useWorkspace";
import type { SessionDialogRequest } from "./SessionActions";
import { sidebarSessionTitle } from "./sidebarSessions";

export function SessionDialog({
  request,
  workspace,
  onClose,
}: {
  request: SessionDialogRequest;
  workspace: WorkspaceController;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const session = workspace.state.sessions.find(
    (item) => item.id === request.sessionId,
  );
  const rename = request.mode === "rename";
  useEffect(() => {
    dialog.current?.showModal();
    if (rename) input.current?.select();
    return () => dialog.current?.close();
  }, [rename]);
  if (!session) return null;
  const title = sidebarSessionTitle(session);
  const blocked =
    workspace.runningIds.includes(session.id) ||
    workspace.workflows.hasOpenRun(session.id) ||
    Boolean(session.workflow?.pending || session.pendingWorkflow);
  return (
    <dialog
      ref={dialog}
      className="session-dialog"
      aria-labelledby="session-dialog-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (rename)
            workspace.renameChat(session.id, input.current?.value ?? "");
          else if (!blocked) workspace.removeChat(session.id);
          else return;
          onClose();
        }}
      >
        <div className="session-dialog-heading">
          <h2 id="session-dialog-title">
            {rename ? "重命名会话" : "删除会话"}
          </h2>
          <button
            type="button"
            className="icon-control"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        {rename ? (
          <label className="session-title-field">
            会话名称
            <input
              ref={input}
              autoFocus
              required
              maxLength={100}
              defaultValue={title}
            />
          </label>
        ) : (
          <p>确定删除“{title}”？本机对话记录无法恢复，已生成的文件会保留。</p>
        )}
        <div className="session-dialog-actions">
          <button type="button" className="tool-button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className={`primary-button${rename ? "" : " danger"}`}
            disabled={!rename && blocked}
          >
            {rename ? "保存" : "删除"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
