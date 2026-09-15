import React, { useRef, useState } from "react";
import type { FlowRun, FlowStep, JsonValue } from "@aura/protocol/types";
import { workflowApi, WorkflowApiError } from "../workflowSessions";
import { WorkflowInput, schemaInitialValue } from "./WorkflowInput";

function StepInput({
  step,
  busy,
  submit,
}: {
  step: FlowStep;
  busy: boolean;
  submit(
    operation: "answer" | "resolve",
    step: FlowStep,
    action?: string,
    output?: JsonValue,
  ): Promise<void>;
}) {
  const schema =
    "outputSchema" in step
      ? step.outputSchema
      : { type: "string", minLength: 1, maxLength: 80_000 };
  const [text, setText] = useState(() =>
    JSON.stringify(schemaInitialValue(schema), null, 2),
  );
  const [showForm, setShowForm] = useState(step.kind === "checkpoint");
  const [error, setError] = useState("");
  const checkpoint = step.kind === "checkpoint";
  async function send() {
    let output: JsonValue;
    try {
      output = JSON.parse(text);
    } catch {
      setError("请输入有效的 JSON。");
      return;
    }
    setError("");
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
      aria-label={`${step.label} ${checkpoint ? "等待输入" : "结果待确认"}`}
    >
      <h4>{step.label}</h4>
      <p>
        {checkpoint
          ? step.prompt
          : "上次执行的结果尚未确认。重试可能再次执行外部操作，也可以提交已确认的结果。"}
      </p>
      {!checkpoint && (
        <div className="workflow-history-actions">
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => void submit("resolve", step, "retry")}
          >
            重试此步骤
          </button>
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => setShowForm(!showForm)}
          >
            提交已有结果
          </button>
          <button
            className="text-control"
            disabled={busy}
            onClick={() => void submit("resolve", step, "terminate")}
          >
            终止运行
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
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="tool-button" disabled={busy} type="submit">
            {checkpoint ? "提交答案并继续" : "确认结果"}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
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
            暂停运行
          </button>
        )}
        {run.status === "pausing" && (
          <p role="status">正在等待已开始的步骤结束…</p>
        )}
        {run.status === "paused" && (
          <button
            className="tool-button"
            disabled={busy}
            onClick={() => void command("resume")}
          >
            继续运行
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
            取消运行
          </button>
        )}
      </div>
      {run.steps
        .filter(
          (step) =>
            (run.status === "waiting_input" &&
              step.status === "waiting_input") ||
            (run.status === "needs_attention" && step.status === "unknown"),
        )
        .map((step) => (
          <StepInput
            key={step.stepKey ?? step.id}
            step={step}
            busy={busy}
            submit={command}
          />
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {run.recoveryEvents?.length ? (
        <details>
          <summary>恢复记录</summary>
          {run.recoveryEvents.map((event, index) => (
            <p key={index}>
              {new Date(event.at).toLocaleString()} · {event.reason}
            </p>
          ))}
        </details>
      ) : null}
    </div>
  );
}
