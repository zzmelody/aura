import React, { useEffect, useRef, useState } from "react";
import type { WorkspaceTerminalInfo } from "@aura/protocol/types";

export function TerminalCloseDialog({
  terminal,
  onConfirm,
  onCancel,
}: {
  terminal: WorkspaceTerminalInfo;
  onConfirm(): Promise<void>;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="session-dialog"
      aria-labelledby="terminal-close-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void onConfirm().catch(() => {
            setError("终端未能关闭，请检查服务连接后重试。");
            setBusy(false);
          });
        }}
      >
        <h2 id="terminal-close-title">关闭 {terminal.title}？</h2>
        <p>
          终端可能仍有任务运行，关闭会结束其中的进程。收起工具面板可以保留任务。
        </p>
        {error ? (
          <p role="alert" className="coding-notice">
            {error}
          </p>
        ) : null}
        <div className="session-dialog-actions">
          <button type="button" className="tool-button" onClick={onCancel}>
            保留终端
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "正在关闭…" : "关闭终端"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
