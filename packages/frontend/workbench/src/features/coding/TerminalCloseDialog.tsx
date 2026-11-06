import React, { useEffect, useRef, useState } from "react";
import { useToolMessages } from "../../tool-messages.ts";
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
  const { t } = useToolMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
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
          setFailed(false);
          void onConfirm().catch(() => {
            setFailed(true);
            setBusy(false);
          });
        }}
      >
        <h2 id="terminal-close-title">
          {t("closeTerminalTitle", { name: terminal.title })}
        </h2>
        <p>{t("closeTerminalHint")}</p>
        {failed ? (
          <p role="alert" className="coding-notice">
            {t("terminalCloseFailed")}
          </p>
        ) : null}
        <div className="session-dialog-actions">
          <button type="button" className="tool-button" onClick={onCancel}>
            {t("keepTerminal")}
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? t("closingTerminal") : t("closeTerminal")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
