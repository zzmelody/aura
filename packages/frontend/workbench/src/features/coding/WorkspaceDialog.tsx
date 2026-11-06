import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import type { CodingProjectInfo } from "@aura/protocol/types";
import {
  chooseWorkflowPath,
  workflowFilePickerAvailable,
} from "../../file-picker";
import { createProject, relocateProject, renameProject } from "./api";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import { useSidebarMessages } from "../../sidebar-messages.ts";

/**
 * Creates a workspace, or edits the name and directory of an existing one.
 * The directory must be an absolute path the Aura service can reach; the
 * desktop host can also pick it with the system folder dialog.
 */
export function WorkspaceDialog({
  endpoint,
  workspace,
  onSaved,
  onClose,
}: {
  endpoint: string;
  /** The workspace to configure; omitted when creating one. */
  workspace?: CodingProjectInfo;
  onSaved(saved: CodingProjectInfo): void;
  onClose(): void;
}) {
  const { t, i18n } = useSidebarMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(workspace?.title ?? "");
  const [directory, setDirectory] = useState(workspace?.directory ?? "");
  const [error, setError] = useState<string | MessageReference>("");
  const [saving, setSaving] = useState(false);
  /** The in-flight save; closing the dialog aborts it. */
  const pending = useRef<AbortController | undefined>(undefined);
  const picker = workflowFilePickerAvailable();
  const editing = Boolean(workspace);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      pending.current?.abort();
      element?.close();
    };
  }, []);

  const pick = async () => {
    setError("");
    try {
      const chosen = await chooseWorkflowPath("directory");
      if (chosen) setDirectory(chosen);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const save = async () => {
    const path = directory.trim();
    const name = title.trim();
    if (!path) return;
    setSaving(true);
    setError("");
    const abort = new AbortController();
    pending.current = abort;
    // The first request may wait for the DSH service to start (the host allows
    // 120 s); past this budget the user gets an error, not a frozen dialog.
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(150_000),
    ]);
    try {
      let saved: CodingProjectInfo;
      if (!workspace) saved = await createProject(endpoint, path, name, signal);
      else {
        saved =
          path === workspace.directory
            ? workspace
            : await relocateProject(endpoint, workspace.id, path, signal);
        if (name && name !== saved.title)
          saved = await renameProject(endpoint, saved.id, name, signal);
      }
      onSaved(saved);
      onClose();
    } catch (reason) {
      if (abort.signal.aborted) return;
      setError(
        signal.aborted
          ? { namespace: "sidebar", key: "serviceTimeout" }
          : errorMessage(reason),
      );
    } finally {
      if (pending.current === abort) pending.current = undefined;
      if (!abort.signal.aborted) setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="session-dialog workspace-dialog"
      aria-labelledby="workspace-dialog-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="session-dialog-heading">
          <h2 id="workspace-dialog-title">
            {editing ? t("configureSpace") : t("createSpace")}
          </h2>
          <button
            type="button"
            className="icon-control"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <label className="session-title-field">
          {t("name")}
          <input
            maxLength={100}
            placeholder={t("defaultDirectoryName")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="session-title-field">
          {t("workingDirectory")}
          <span className="workspace-directory-field">
            <input
              required
              autoFocus
              maxLength={4096}
              placeholder={t("absoluteDirectory")}
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
            {picker ? (
              <button
                type="button"
                className="tool-button"
                onClick={() => void pick()}
              >
                <FolderOpen size={15} />
                {t("browse")}
              </button>
            ) : null}
          </span>
        </label>
        {editing ? (
          <p className="workspace-dialog-hint">{t("relocateHint")}</p>
        ) : null}
        {saving ? (
          <p className="workspace-dialog-hint" role="status">
            <LoaderCircle
              size={13}
              className="workspace-dialog-spin"
              aria-hidden="true"
            />
            {t("savingSpace")}
          </p>
        ) : null}
        {error ? (
          <p className="workspace-dialog-error" role="alert">
            {messageText(error, i18n)}
          </p>
        ) : null}
        <div className="session-dialog-actions">
          <button type="button" className="tool-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !directory.trim()}
          >
            {saving ? t("saving") : editing ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
