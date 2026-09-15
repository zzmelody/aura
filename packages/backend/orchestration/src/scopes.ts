import type { FlowContext, FlowScope } from "./flow-api.ts";
import { FlowError, flowIdSchema, parse } from "./schema.ts";

export interface ScopeOperations {
  context: Pick<FlowContext, "runId" | "mode" | "signal">;
  boundary(): void;
  fatal(error: Error): void;
  agent(
    path: string[],
    request: Parameters<FlowScope["agent"]>[0],
  ): ReturnType<FlowScope["agent"]>;
  action(
    path: string[],
    request: Parameters<FlowScope["action"]>[0],
  ): ReturnType<FlowScope["action"]>;
  memo(
    path: string[],
    request: Parameters<FlowScope["memo"]>[0],
  ): Promise<unknown>;
  checkpoint(
    path: string[],
    request: Parameters<FlowScope["checkpoint"]>[0],
  ): Promise<unknown>;
}

/** Lazy tracked calls prevent a forgotten await from starting an external effect. */
class Scope {
  private used = new Set<string>();
  private pending?: { consumed: boolean; task?: Promise<unknown> };
  private closed = false;
  private ops: ScopeOperations;
  private path: string[];
  private inParallel: boolean;
  constructor(ops: ScopeOperations, path: string[], inParallel: boolean) {
    this.ops = ops;
    this.path = path;
    this.inParallel = inParallel;
  }
  private fail(message: string): never {
    const error = new FlowError(`FLOW_SCOPE_ERROR: ${message}`);
    this.ops.fatal(error);
    throw error;
  }
  call<T>(id: string, execute: () => T | Promise<T>): Promise<T> {
    if (this.closed) this.fail("作用域已经退出。");
    this.ops.boundary();
    if (this.pending)
      this.fail("串行作用域必须 await 上一步；并发请使用 parallel。");
    parse(flowIdSchema, id);
    if (this.used.has(id)) this.fail(`同级步骤 ID 不能重复：${id}`);
    this.used.add(id);
    const record: NonNullable<Scope["pending"]> = { consumed: false };
    this.pending = record;
    const start = (): Promise<T> => {
      record.consumed = true;
      if (!record.task) {
        record.task = Promise.resolve()
          .then(() => {
            this.ops.boundary();
            return execute();
          })
          .finally(() => {
            if (this.pending === record) this.pending = undefined;
          });
        record.task.catch(() => undefined);
      }
      return record.task as Promise<T>;
    };
    return {
      [Symbol.toStringTag]: "Promise",
      then: (yes, no) => start().then(yes, no),
      catch: (no) => start().catch(no),
      finally: (done) => start().finally(done),
    } as Promise<T>;
  }
  async run<T>(callback: (scope: FlowScope) => T | Promise<T>): Promise<T> {
    try {
      return await callback(this.api());
    } finally {
      const pending = this.pending;
      this.closed = true;
      if (pending) {
        await pending.task?.catch(() => undefined);
        this.fail("作用域退出时存在未 await 的步骤。");
      }
    }
  }
  api(): FlowScope {
    const api = {
      ...this.ops.context,
      sequence: <T>(
        options: { id: string },
        callback: (scope: FlowScope) => T | Promise<T>,
      ) =>
        this.call(options.id, () =>
          new Scope(this.ops, [...this.path, options.id], this.inParallel).run(
            callback,
          ),
        ),
      parallel: (options: {
        id: string;
        branches: Record<string, (scope: FlowScope) => unknown>;
      }) =>
        this.call(options.id, async () => {
          const branches = Object.entries(options.branches);
          for (const [id] of branches) parse(flowIdSchema, id);
          const results = await Promise.allSettled(
            branches.map(([id, callback]) =>
              new Scope(this.ops, [...this.path, options.id, id], true).run(
                callback,
              ),
            ),
          );
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
          return Object.fromEntries(
            results.map((result, i) => [
              branches[i]![0],
              result.status === "fulfilled" ? result.value : undefined,
            ]),
          );
        }),
      agent: (request: Parameters<FlowScope["agent"]>[0]) =>
        this.call(request.id, () => this.ops.agent(this.path, request)),
      action: (request: Parameters<FlowScope["action"]>[0]) =>
        this.call(request.id, () => this.ops.action(this.path, request)),
      memo: (request: Parameters<FlowScope["memo"]>[0]) =>
        this.call(request.id, () => this.ops.memo(this.path, request)),
      checkpoint: (request: Parameters<FlowScope["checkpoint"]>[0]) =>
        this.call(request.id, () => {
          if (this.inParallel)
            this.fail("V1 不允许在 parallel 分支中等待 checkpoint。");
          return this.ops.checkpoint(this.path, request);
        }),
    };
    return api as FlowScope;
  }
}

export async function runScoped<T>(
  ops: ScopeOperations,
  callback: (context: FlowContext) => T | Promise<T>,
): Promise<T> {
  const root = new Scope(ops, [], false);
  return root.run((scope) => {
    const context: FlowContext = { ...ops.context, sequence: scope.sequence };
    for (const name of ["agent", "action", "memo", "checkpoint", "parallel"])
      Object.defineProperty(context, name, {
        get() {
          const error = new FlowError(
            "FLOW_SCOPE_ERROR: 根 ctx 只允许 sequence；请迁移旧 Flow 调用。",
          );
          ops.fatal(error);
          throw error;
        },
      });
    return callback(Object.freeze(context));
  });
}
