import React, { useRef, useState } from "react";
import { apiErrorText } from "../api-error-messages.ts";
import {
  useWorkflowMessages,
  workflowMessage as message,
} from "../workflow-messages.ts";
import {
  errorMessage,
  messageText,
  formatDate,
  type MessageReference,
} from "@aura/i18n/runtime";
import type { FlowRun, FlowStep, JsonValue } from "@aura/protocol/types";
import { workflowApi, WorkflowApiError } from "../workflowSessions";
import { WorkflowInput, schemaInitialValue } from "./WorkflowInput";

function StepInput({
  step,
  busy,
  submit,
  endpoint,
}: {
  step: FlowStep;
  busy: boolean;
  endpoint: string;
  submit(
    operation: "answer" | "resolve",
    step: FlowStep,
    action?: string,
    output?: JsonValue,
  ): Promise<void>;
}) {
  const { t } = useWorkflowMessages();
  const schema =
    "outputSchema" in step
      ? step.outputSchema
      : { type: "string", minLength: 1, maxLength: 80_000 };
  const [text, setText] = useState(() =>
    JSON.stringify(schemaInitialValue(schema), null, 2),
  );
  const [showForm, setShowForm] = useState(step.kind === "checkpoint");
  const [invalidJson, setInvalidJson] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const checkpoint = step.kind === "checkpoint";
  async function send() {
    if (imageUploading) return;
    let output: JsonValue;
    try {
      output = JSON.parse(text);
    } catch {
      setInvalidJson(true);
      return;
    }
    setInvalidJson(false);
    await submit(
      checkpoint ? "answer" : "resolve",
      step,
      checkpoint ? undefined : "submit_output",
      output,
    );
  }
  return (
    <section
      className="workflow-human-step"
      aria-label={t(checkpoint ? "waitingInputLabel" : "unconfirmedLabel", {
        label: step.label,
      })}
    >
      <h4>{step.label}</h4>
      <p>{checkpoint ? step.prompt : t("unknownResultHint")}</p>
      {!checkpoint && (
        <div className="workflow-history-actions">
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => void submit("resolve", step, "retry")}
          >
            {t("retryStep")}
          </button>
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => setShowForm(!showForm)}
          >
            {t("submitExisting")}
          </button>
          <button
            className="text-control"
            disabled={busy}
            onClick={() => void submit("resolve", step, "terminate")}
          >
            {t("terminateRun")}
          </button>
        </div>
      )}
      {showForm && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <WorkflowInput
            schema={schema}
            text={text}
            onChange={setText}
            disabled={busy}
            endpoint={endpoint}
            onUploadBusyChange={setImageUploading}
          />
          {invalidJson && (
            <p className="error" role="alert">
              {t("invalidJson")}
            </p>
          )}
          <button
            className="tool-button"
            disabled={busy || imageUploading}
            type="submit"
          >
            {checkpoint ? t("answerContinue") : t("confirmResult")}
          </button>
        </form>
      )}
    </section>
  );
}

export function WorkflowControls({
  endpoint,
  run,
  receive,
}: {
  endpoint: string;
  run: FlowRun;
  receive(endpoint: string, run: FlowRun): void;
}) {
  const { t, i18n } = useWorkflowMessages();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | MessageReference>("");
  // Keep the same command identity after an uncertain network response.
  const pending = useRef(new Map<string, string>());
  async function command(
    operation: "pause" | "resume" | "cancel" | "answer" | "resolve",
    step?: FlowStep,
    action?: string,
    output?: JsonValue,
  ) {
    if (busy) return;
    const path = `/runs/${encodeURIComponent(run.id)}${step ? `/steps/${encodeURIComponent(step.stepKey ?? step.id)}` : ""}/${operation}`;
    const payload = {
      ...(action ? { action } : {}),
      ...(output !== undefined ? { output } : {}),
    };
    const key = `${path}:${JSON.stringify(payload)}`;
    const requestId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, requestId);
    setBusy(true);
    setError("");
    try {
      const next = await workflowApi<FlowRun>(endpoint, path, {
        requestId,
        ...payload,
      });
      pending.current.delete(key);
      receive(endpoint, next);
    } catch (cause) {
      if (
        cause instanceof WorkflowApiError &&
        cause.status >= 400 &&
        cause.status < 500
      )
        pending.current.delete(key);
      setError(errorMessage(cause, message("operationFailed")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-run-controls">
      <div className="workflow-history-actions">
        {(run.status === "queued" || run.status === "running") && (
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => void command("pause")}
          >
            {t("pauseRun")}
          </button>
        )}
        {run.status === "pausing" && <p role="status">{t("waitingSteps")}</p>}
        {run.status === "paused" && (
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => void command("resume")}
          >
            {t("resumeRun")}
          </button>
        )}
        {["paused", "waiting_input", "needs_attention"].includes(
          run.status,
        ) && (
          <button
            className="text-control"
            disabled={busy}
            onClick={() => void command("cancel")}
          >
            {t("cancelRun")}
          </button>
        )}
      </div>
      {run.steps
        .filter(
          (step) =>
            (step.kind !== "flow" &&
              run.status === "waiting_input" &&
              step.status === "waiting_input") ||
            (step.kind !== "flow" &&
              run.status === "needs_attention" &&
              step.status === "unknown"),
        )
        .map((step) => (
          <StepInput
            key={step.stepKey ?? step.id}
            step={step}
            busy={busy}
            submit={command}
            endpoint={endpoint}
          />
        ))}
      {error && (
        <p className="error" role="alert">
          {messageText(error, i18n)}
        </p>
      )}
      {run.recoveryEvents?.length ? (
        <details>
          <summary>{t("recoveryHistory")}</summary>
          {run.recoveryEvents.map((event, index) => (
            <p className="workflow-recovery-event" key={index}>
              {formatDate(event.at, {
                dateStyle: "short",
                timeStyle: "medium",
              })}{" "}
              ·{" "}
              {messageText(
                apiErrorText(event.reasonDetails, event.reason),
                i18n,
              )}
            </p>
          ))}
        </details>
      ) : null}
    </div>
  );
}
