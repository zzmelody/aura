import { randomUUID } from "node:crypto";
import type { ActionRun } from "@aura/protocol/types";
import type { ActionRegistry, LoadedAction } from "./action-registry.ts";
import type { ActionRuntime } from "./actions.ts";
import type { Table } from "./types.ts";
import {
  active,
  actionStartSchema,
  FlowError,
  jsonValue,
  parse,
} from "./schema.ts";

/** Durable local Action invocations; dispatch itself always goes through DSH. */
export class ActionRuns {
  private table: Table<ActionRun>;
  private registry: ActionRegistry;
  private runtime: ActionRuntime;
  private refresh: () => Promise<void>;
  private cwd: string;
  private admission: Promise<unknown> = Promise.resolve();
  private closing = false;
  readonly running = new Map<
    string,
    { abort: AbortController; task: Promise<void> }
  >();

  constructor(options: {
    table: Table<ActionRun>;
    registry: ActionRegistry;
    runtime: ActionRuntime;
    refresh(): Promise<void>;
    cwd: string;
  }) {
    this.table = options.table;
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.refresh = options.refresh;
    this.cwd = options.cwd;
  }

  async initialize() {
    for (const [id, run] of this.table.entries())
      if (active(run.status))
        await this.table.put(id, {
          ...run,
          status: "interrupted",
          finishedAt: Date.now(),
          error: "运行时曾中断；未重放 Action 副作用。",
        });
  }

  get(id: string) {
    const run = this.table.get(id);
    if (!run) throw new FlowError("Action 运行不存在。", 404);
    return run;
  }

  start(input: unknown) {
    const task = this.admission.then(() => this.admit(input));
    this.admission = task.catch(() => undefined);
    return task;
  }

  private async admit(input: unknown) {
    const request = parse(actionStartSchema, input);
    const args = jsonValue(request.input, "Action 入参");
    const previous = [...this.table.entries()].find(
      ([, run]) => run.requestId === request.requestId,
    )?.[1];
    if (previous) {
      if (
        previous.actionId !== request.actionId ||
        previous.mode !== request.mode ||
        JSON.stringify(previous.input) !== JSON.stringify(args)
      )
        throw new FlowError("同一请求 ID 不能用于不同输入。", 409);
      return previous;
    }
    if (this.closing || this.running.size >= 2)
      throw new FlowError("已有两个 Action 在运行，请稍后再试。", 503);
    await this.refresh();
    const action = this.registry.get(request.actionId);
    const run: ActionRun = {
      id: randomUUID(),
      requestId: request.requestId,
      actionId: action.id,
      sourceHash: action.sourceHash,
      input: args,
      mode: request.mode,
      status: "queued",
      createdAt: Date.now(),
    };
    await this.table.put(run.id, run);
    const entry = { abort: new AbortController(), task: Promise.resolve() };
    this.running.set(run.id, entry);
    entry.task = this.execute(run, action, entry.abort.signal).finally(() =>
      this.running.delete(run.id),
    );
    entry.task.catch(() => undefined);
    return run;
  }

  private async execute(
    run: ActionRun,
    action: LoadedAction,
    signal: AbortSignal,
  ) {
    try {
      await this.table.update(run.id, (current) => ({
        ...current,
        status: "running",
      }));
      const output = await this.runtime.execute(
        action,
        run.input,
        { cwd: this.cwd, mode: run.mode, runId: run.id },
        signal,
      );
      signal.throwIfAborted();
      await this.table.update(run.id, (current) => ({
        ...current,
        status: "completed",
        output,
        finishedAt: Date.now(),
      }));
    } catch (error) {
      await this.table.update(run.id, (current) => ({
        ...current,
        status: signal.aborted ? "cancelled" : "failed",
        finishedAt: Date.now(),
        error: signal.aborted
          ? "Action 已取消。"
          : error instanceof FlowError
            ? error.message
            : "Action 执行失败。",
      }));
    }
  }

  async wait(id: string) {
    this.get(id);
    await this.running.get(id)?.task;
    return this.get(id);
  }
  async cancel(id: string) {
    this.get(id);
    this.running.get(id)?.abort.abort(new Error("cancelled"));
    return this.wait(id);
  }
  async close() {
    this.closing = true;
    await this.admission;
    for (const entry of this.running.values())
      entry.abort.abort(new Error("runtime closing"));
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.task),
    );
  }
}
