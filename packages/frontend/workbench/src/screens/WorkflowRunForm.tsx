import React, { useEffect, useRef, useState } from "react";
import { useWorkflowMessages } from "../workflow-messages.ts";
import { LoaderCircle, Play, X } from "lucide-react";
import type { FlowMode, JsonValue } from "@aura/protocol/types";
import { WorkflowInput } from "./WorkflowInput";

/** Inline, non-modal parameter block shared by bound and ordinary chats. */
export const WorkflowRunForm = React.forwardRef<
  HTMLFormElement,
  {
    id: string;
    title: string;
    subtitle: string;
    schema?: JsonValue;
    text: string;
    onTextChange(text: string): void;
    endpoint: string;
    initialMode: FlowMode;
    locked: boolean;
    submitting: boolean;
    unavailable?: boolean;
    error?: string;
    notice?: React.ReactNode;
    submitLabel?: string;
    onSubmit(input: JsonValue, mode: FlowMode): void;
    onClose(): void;
  }
>(function WorkflowRunForm(
  {
    id,
    title,
    subtitle,
    schema,
    text,
    onTextChange,
    endpoint,
    initialMode,
    locked,
    submitting,
    unavailable,
    error,
    notice,
    submitLabel,
    onSubmit,
    onClose,
  },
  ref,
) {
  const { t } = useWorkflowMessages();
  const [mode, setMode] = useState<FlowMode>(initialMode);
  const [jsonMode, setJsonMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [inputError, setInputError] = useState(false);
  const local = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      local.current?.scrollIntoView({ block: "nearest" });
      local.current
        ?.querySelector<HTMLElement>("textarea, input, select")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <form
      ref={(node) => {
        local.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      id={id}
      className="workflow-composer workflow-inline-composer"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (uploading) return;
        let input: JsonValue;
        try {
          input = JSON.parse(text) as JsonValue;
        } catch {
          setInputError(true);
          return;
        }
        setInputError(false);
        onSubmit(input, mode);
      }}
    >
      <div className="workflow-inline-heading">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="icon-control"
          aria-label={t("closeRunInput")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {notice}
      <WorkflowInput
        schema={jsonMode ? undefined : schema}
        text={text}
        disabled={locked}
        onChange={onTextChange}
        endpoint={endpoint}
        onUploadBusyChange={setUploading}
      />
      {inputError || error ? (
        <p role="alert" className="error">
          {inputError ? t("invalidJson") : error}
        </p>
      ) : null}
      <div className="workflow-compose-actions">
        <select
          aria-label={t("runMode")}
          value={mode}
          disabled={locked}
          onChange={(event) => setMode(event.target.value as FlowMode)}
        >
          <option value="demo">{t("demo")}</option>
          <option value="codex">Codex</option>
          <option value="lumina">Lumina</option>
          <option value="custom">{t("customApi")}</option>
        </select>
        <button
          type="button"
          className="text-control"
          aria-pressed={jsonMode}
          onClick={() => setJsonMode(!jsonMode)}
        >
          {jsonMode ? t("formInput") : "JSON"}
        </button>
        <span className="workflow-compose-spacer" />
        <button
          className="primary-button"
          type="submit"
          disabled={locked || uploading || unavailable}
        >
          {submitting ? (
            <LoaderCircle size={14} className="workflow-spinner" />
          ) : (
            <Play size={14} />
          )}
          {submitting ? t("submitting") : (submitLabel ?? t("startRun"))}
        </button>
      </div>
      <p className="workflow-compose-note">{t("savedInConversation")}</p>
    </form>
  );
});
