import {
  CodedFlowError,
  FlowError,
  readErrorDetails,
  readFlowFailureDetails,
  type FlowFailureDetails,
} from "@aura/protocol/errors";
import type { FlowRun } from "@aura/protocol/types";
import { createHash } from "node:crypto";

const digest = (message: string) =>
  createHash("sha256").update(message).digest("hex");

/** Keeps a compound display reason while retaining the legacy durable message. */
export class FlowDisplayError extends FlowError {
  readonly display: FlowFailureDetails;
  constructor(message: string, display: FlowFailureDetails) {
    super(message);
    this.display = display;
  }
}

export function flowFailureDetails(
  error: unknown,
): FlowFailureDetails | undefined {
  if (error instanceof FlowDisplayError)
    return readFlowFailureDetails(error.display);
  if (error instanceof CodedFlowError) {
    const failure = readErrorDetails(error.details);
    if (failure) return { failure };
  }
}

/** Bounded transient projection, separate from every persistence and execution path. */
export class FlowDisplayErrors {
  private readonly entries = new Map<
    string,
    { digest: string; details: FlowFailureDetails }
  >();
  private key(run: string, step?: string, attempt?: number, eventAt?: number) {
    return JSON.stringify([
      run,
      step ?? null,
      attempt ?? null,
      ...(eventAt === undefined ? [] : [eventAt]),
    ]);
  }
  record(
    run: string,
    message: string,
    details: FlowFailureDetails | undefined,
    step?: string,
    attempt?: number,
    eventAt?: number,
  ) {
    const key = this.key(run, step, attempt, eventAt);
    const safe = readFlowFailureDetails(details);
    this.entries.delete(key);
    if (safe) this.entries.set(key, { digest: digest(message), details: safe });
    while (this.entries.size > 1024)
      this.entries.delete(this.entries.keys().next().value!);
  }
  project(run: FlowRun): FlowRun {
    const copy = structuredClone(run);
    const detail = (
      message: string | undefined,
      step?: string,
      attempt?: number,
      eventAt?: number,
    ) => {
      if (!message) return;
      const entry = this.entries.get(this.key(run.id, step, attempt, eventAt));
      // Equality only verifies ownership of this message; it never classifies text.
      return entry?.digest === digest(message)
        ? structuredClone(entry.details)
        : undefined;
    };
    const details = detail(copy.error);
    if (details) copy.errorDetails = details;
    const events = (values: FlowRun["recoveryEvents"], key?: string) => {
      for (const event of values ?? []) {
        const details = detail(event.reason, key, undefined, event.at);
        if (details) event.reasonDetails = details.failure;
      }
    };
    events(copy.recoveryEvents);
    for (const step of copy.steps) {
      const key = step.stepKey ?? step.id;
      const details = detail(step.error, key);
      if (details) step.errorDetails = details;
      events(step.recoveryEvents, key);
      for (const attempt of step.attempts ?? []) {
        const details = detail(attempt.error, key, attempt.number);
        if (details) attempt.errorDetails = details;
      }
    }
    return copy;
  }
}
