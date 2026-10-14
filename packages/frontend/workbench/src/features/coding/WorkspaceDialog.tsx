import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import type { CodingProjectInfo } from "@aura/protocol/types";
import {
  chooseWorkflowPath,
  workflowFilePickerAvailable,
} from "../../file-picker";
import { createProject, relocateProject, renameProject } from "./api";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(workspace?.title ?? "");
  const [directory, setDirectory] = useState(workspace?.directory ?? "");
  const [error, setError] = useState("");
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
      setError(reason instanceof Error ? reason.message : String(reason));
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
          ? "Aura 服务长时间没有响应，请确认服务已启动后重试。"
          : reason instanceof Error
            ? reason.message
            : String(reason),
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
            {editing ? "配置工作空间" : "新建工作空间"}
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
        <label className="session-title-field">
          名称
          <input
            maxLength={100}
            placeholder="默认使用目录名"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="session-title-field">
          工作目录
          <span className="workspace-directory-field">
            <input
              required
              autoFocus
              maxLength={4096}
              placeholder="Aura 服务端可访问的绝对路径，例如 D:\projects\demo"
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
                浏览
              </button>
            ) : null}
          </span>
        </label>
        {editing ? (
          <p className="workspace-dialog-hint">
            更换目录后，新对话会在新目录中进行；原目录下的文件和对话记录不会被删除。
          </p>
        ) : null}
        {saving ? (
          <p className="workspace-dialog-hint" role="status">
            <LoaderCircle
              size={13}
              className="workspace-dialog-spin"
              aria-hidden="true"
            />
            正在保存，首次使用需要等待 Aura 服务启动…
          </p>
        ) : null}
        {error ? (
          <p className="workspace-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="session-dialog-actions">
          <button type="button" className="tool-button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !directory.trim()}
          >
            {saving ? "保存中…" : editing ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
