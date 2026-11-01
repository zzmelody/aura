import type { FlowRun } from "@aura/protocol/types";
import {
  isWorkflowOpen,
  workflowApi,
  workflowRunKey,
} from "./workflowSessions.ts";

export interface WorkflowRunSnapshot {
  run?: FlowRun;
  error?: string;
}
interface Entry {
  endpoint: string;
  id: string;
  snapshot: WorkflowRunSnapshot;
  signature?: string;
  listeners: Set<() => void>;
  request?: Promise<FlowRun>;
  abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
const empty: WorkflowRunSnapshot = {};

/** One cancellable reader per runtime/run, shared by background state and every view. */
export class WorkflowRunStore {
  private readonly entries = new Map<string, Entry>();
  private readonly read: (
    endpoint: string,
    id: string,
    signal: AbortSignal,
  ) => Promise<FlowRun>;
  constructor(
    read = (endpoint: string, id: string, signal: AbortSignal) =>
      workflowApi<FlowRun>(
        endpoint,
        `/runs/${encodeURIComponent(id)}`,
        undefined,
        signal,
      ),
  ) {
    this.read = read;
  }
  private entry(endpoint: string, id: string): Entry {
    const key = workflowRunKey(endpoint, id);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { endpoint, id, snapshot: empty, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  snapshot(endpoint: string, id: string): WorkflowRunSnapshot {
    return this.entries.get(workflowRunKey(endpoint, id))?.snapshot ?? empty;
  }
  publish(endpoint: string, run: FlowRun): void {
    const entry = this.entry(endpoint, run.id);
    if (
      entry.snapshot.run &&
      (entry.snapshot.run.updatedAt ?? entry.snapshot.run.createdAt) >
        (run.updatedAt ?? run.createdAt)
    )
      return;
    const signature = JSON.stringify(run);
    if (signature === entry.signature && !entry.snapshot.error) return;
    entry.signature = signature;
    entry.snapshot = { run };
    if (!isWorkflowOpen(run.status)) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    for (const listener of entry.listeners) listener();
    this.prune();
  }
  subscribe(endpoint: string, id: string, listener: () => void): () => void {
    const entry = this.entry(endpoint, id);
    entry.listeners.add(listener);
    if (
      !entry.request &&
      !entry.timer &&
      (!entry.snapshot.run || isWorkflowOpen(entry.snapshot.run.status))
    )
      void this.refresh(endpoint, id).catch(() => undefined);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.abort?.abort();
      }
      this.prune();
    };
  }
  refresh(endpoint: string, id: string): Promise<FlowRun> {
    const entry = this.entry(endpoint, id);
    if (entry.request) return entry.request;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const abort = new AbortController();
    entry.abort = abort;
    const request = Promise.resolve()
      .then(() => this.read(endpoint, id, abort.signal))
      .then((run) => {
        if (!abort.signal.aborted) this.publish(endpoint, run);
        return run;
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) {
          entry.snapshot = {
            ...entry.snapshot,
            error:
              cause instanceof Error
                ? cause.message
                : "运行记录读取失败，请重试。",
          };
          for (const listener of entry.listeners) listener();
        }
        throw cause;
      })
      .finally(() => {
        entry.request = undefined;
        entry.abort = undefined;
        if (
          entry.listeners.size &&
          (!entry.snapshot.run || isWorkflowOpen(entry.snapshot.run.status))
        ) {
          const hidden =
            typeof document !== "undefined" &&
            document.visibilityState === "hidden";
          entry.timer = setTimeout(
            () => {
              entry.timer = undefined;
              void this.refresh(endpoint, id).catch(() => undefined);
            },
            hidden ? 10_000 : entry.snapshot.error ? 4_000 : 2_000,
          );
        }
        this.prune();
      });
    entry.request = request;
    return request;
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 50) break;
      if (!entry.listeners.size && !entry.request) this.entries.delete(key);
    }
  }
  close(): void {
    for (const entry of this.entries.values()) {
      entry.listeners.clear();
      clearTimeout(entry.timer);
      entry.abort?.abort();
    }
    this.entries.clear();
  }
}

export const workflowRuns = new WorkflowRunStore();
