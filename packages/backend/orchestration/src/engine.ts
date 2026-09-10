import { randomUUID } from "node:crypto";
import type {
  FlowContext,
  FlowAgentRequest,
  FlowAgentResult,
} from "./flow-api.ts";
import type {
  FlowCatalog,
  FlowRun,
  FlowStep,
  JsonValue,
} from "@aura/protocol/types";
import {
  active,
  agentRequestSchema,
  FlowError,
  parse,
  parseJson,
  startSchema,
} from "./schema.ts";
import type { LoadedFlow } from "./registry.ts";
import type { EngineOptions, Table } from "./types.ts";

class ConcurrencyGate {
  private limit: number;
  private active = 0;
  private waiting: Array<{
    signal: AbortSignal;
    resolve(release: () => void): void;
    reject(reason: unknown): void;
    abort(): void;
  }> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiting = this.waiting.filter((item) => item !== waiter);
          reject(signal.reason);
        },
      };
      if (this.active < this.limit) this.admit(waiter);
      else {
        this.waiting.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
    });
  }

  private admit(waiter: (typeof this.waiting)[number]) {
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.signal.aborted) return waiter.reject(waiter.signal.reason);
    this.active++;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      while (this.waiting.length) {
        const next = this.waiting.shift()!;
        if (next.signal.aborted) {
          next.reject(next.signal.reason);
          continue;
        }
        this.admit(next);
        break;
      }
    });
  }
}

interface ActiveRun {
  abort: AbortController;
  task: Promise<void>;
  flow: LoadedFlow;
  gate: ConcurrencyGate;
  stepIds: Set<string>;
  agentTasks: Set<Promise<unknown>>;
  agentRecords: Array<{ observed: boolean; failure?: unknown }>;
  cancelRequested: boolean;
}

const preview = (input: JsonValue) => {
  const text = JSON.stringify(input);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
};

/** Backend-only code Flow runner; DSH owns agents, presets and transcripts. */
export class FlowEngine {
  runs: Table<FlowRun>;
  sessions: EngineOptions["sessions"];
  registry: EngineOptions["registry"];
  refreshFlows: EngineOptions["refreshFlows"];
  presets: EngineOptions["presets"];
  running = new Map<string, ActiveRun>();
  private admission: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor({
    domain,
    sessions,
    registry,
    refreshFlows,
    presets,
  }: EngineOptions) {
    this.runs = domain.table("runs");
    this.sessions = sessions;
    this.registry = registry;
    this.refreshFlows = refreshFlows;
    this.presets = presets;
  }

  async initialize() {
    // Never replay arbitrary code or tool side effects after an uncertain exit.
    for (const [id, run] of this.runs.entries())
      if (active(run.status)) {
        await this.runs.put(id, {
          ...run,
          status: "interrupted",
          finishedAt: Date.now(),
          error: "运行时曾中断。保留已有输出和会话，请明确重新运行。",
          steps: run.steps.map((step) =>
            active(step.status)
              ? { ...step, status: "interrupted", finishedAt: Date.now() }
              : step,
          ),
        });
      }
  }

  async catalog(): Promise<FlowCatalog> {
    await this.refreshFlows();
    return { flows: this.registry.catalog(), presets: await this.presets() };
  }

  list() {
    return [...this.runs.entries()]
      .map(([, run]) => ({
        id: run.id,
        flowId: run.flow.id,
        title: run.flow.title,
        inputPreview: preview(run.input),
        status: run.status,
        mode: run.mode,
        createdAt: run.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new FlowError("Flow 运行不存在。", 404);
    return run;
  }

  start(input: unknown) {
    const task = this.admission.then(() => this.admit(input));
    this.admission = task.catch(() => undefined);
    return task;
  }

  private async admit(input: unknown) {
    const request = parse(startSchema, input);
    await this.refreshFlows();
    const flow = this.registry.get(request.flowId);
    const parsedInput = parseJson(flow.inputSchema, request.input, "Flow 入参");
    const previous = [...this.runs.entries()].find(
      ([, run]) => run.requestId === request.requestId,
    )?.[1];
    if (previous) {
      if (
        previous.flow.id !== request.flowId ||
        previous.mode !== request.mode ||
        JSON.stringify(previous.input) !== JSON.stringify(parsedInput)
      )
        throw new FlowError("同一请求 ID 不能用于不同输入。", 409);
      return previous;
    }
    if (this.closing || this.running.size >= 2)
      throw new FlowError("已有两个 Flow 在运行，请稍后再试。", 503);

    const run: FlowRun = {
      id: randomUUID(),
      requestId: request.requestId,
      flow: {
        id: flow.id,
        title: flow.title,
        description: flow.description,
        sourceHash: flow.sourceHash,
      },
      input: parsedInput,
      mode: request.mode,
      status: "queued",
      createdAt: Date.now(),
      steps: [],
    };
    await this.runs.put(run.id, run);
    const activeRun: ActiveRun = {
      abort: new AbortController(),
      task: Promise.resolve(),
      flow,
      gate: new ConcurrencyGate(flow.concurrency),
      stepIds: new Set(),
      agentTasks: new Set(),
      agentRecords: [],
      cancelRequested: false,
    };
    this.running.set(run.id, activeRun);
    activeRun.task = this.execute(run.id, activeRun)
      .catch(async () => {
        activeRun.abort.abort();
        await this.runs.update(run.id, (current) => ({
          ...current,
          status: "failed",
          finishedAt: Date.now(),
          error: "Flow 状态提交失败，请检查后端存储。",
          steps: current.steps.map((step) =>
            active(step.status)
              ? { ...step, status: "interrupted", finishedAt: Date.now() }
              : step,
          ),
        }));
      })
      .finally(() => this.running.delete(run.id));
    activeRun.task.catch(() => undefined);
    return run;
  }

  private async execute(id: string, activeRun: ActiveRun) {
    await this.runs.update(id, (run) => ({ ...run, status: "running" }));
    const context: FlowContext = {
      runId: id,
      mode: this.get(id).mode,
      signal: activeRun.abort.signal,
      agent: (request) => this.agent(id, activeRun, request),
    };
    try {
      const rawOutput = await activeRun.flow.run(context, this.get(id).input);
      while (activeRun.agentTasks.size)
        await Promise.allSettled([...activeRun.agentTasks]);
      activeRun.abort.signal.throwIfAborted();
      const unobserved = activeRun.agentRecords.find(
        (record) => record.failure && !record.observed,
      );
      if (unobserved)
        throw unobserved.failure instanceof Error
          ? unobserved.failure
          : new FlowError("未处理的 Agent 步骤失败。");
      const output = parseJson(
        activeRun.flow.outputSchema,
        rawOutput,
        "Flow 出参",
      );
      await this.runs.update(id, (run) => ({
        ...run,
        status: "completed",
        output,
        finishedAt: Date.now(),
      }));
    } catch (error) {
      activeRun.abort.abort(error);
      while (activeRun.agentTasks.size)
        await Promise.allSettled([...activeRun.agentTasks]);
      const cancelled = activeRun.cancelRequested || this.closing;
      await this.runs.update(id, (run) => ({
        ...run,
        status: cancelled ? "cancelled" : "failed",
        finishedAt: Date.now(),
        error: cancelled
          ? "Flow 已取消。"
          : error instanceof FlowError
            ? error.message
            : "Flow 代码执行失败，请检查后端日志。",
      }));
    }
  }

  private agent(
    runId: string,
    activeRun: ActiveRun,
    input: FlowAgentRequest,
  ): Promise<FlowAgentResult> {
    const record: (typeof activeRun.agentRecords)[number] = {
      observed: false,
    };
    activeRun.agentRecords.push(record);
    const task = this.executeAgent(runId, activeRun, input).catch((error) => {
      record.failure = error;
      throw error;
    });
    activeRun.agentTasks.add(task);
    task
      .catch(() => undefined)
      .finally(() => activeRun.agentTasks.delete(task));
    return {
      [Symbol.toStringTag]: "Promise",
      then(onfulfilled, onrejected) {
        record.observed = true;
        return task.then(onfulfilled, onrejected);
      },
      catch(onrejected) {
        record.observed = true;
        return task.catch(onrejected);
      },
      finally(onfinally) {
        return task.finally(onfinally);
      },
    } as Promise<FlowAgentResult>;
  }

  private async executeAgent(
    runId: string,
    activeRun: ActiveRun,
    input: FlowAgentRequest,
  ): Promise<FlowAgentResult> {
    const request = parse(agentRequestSchema, input);
    if (activeRun.stepIds.size >= 64)
      throw new FlowError("单次 Flow 最多执行 64 个 agent 步骤。");
    if (activeRun.stepIds.has(request.id))
      throw new FlowError(`Flow 步骤 ID 不能重复：${request.id}`);
    activeRun.stepIds.add(request.id);

    const step: FlowStep = {
      id: request.id,
      label: request.label,
      preset: request.preset,
      sessionId: randomUUID(),
      status: "queued",
    };
    await this.runs.update(runId, (run) => ({
      ...run,
      steps: [...run.steps, step],
    }));

    let release: (() => void) | undefined;
    try {
      const preset = (await this.presets()).find(
        (item) => item.id === request.preset,
      );
      if (!preset || preset.unavailable)
        throw new FlowError(`Preset 不存在或不可用：${request.preset}`);
      release = await activeRun.gate.acquire(activeRun.abort.signal);
      await this.updateStep(runId, step.id, {
        status: "running",
        startedAt: Date.now(),
      });
      const output = await this.sessions.execute({
        ...step,
        input: request.prompt,
        mode: this.get(runId).mode,
        timeoutMs: activeRun.flow.agentTimeoutMs,
        signal: activeRun.abort.signal,
      });
      activeRun.abort.signal.throwIfAborted();
      if (!output.trim() || output.length > 80_000)
        throw new FlowError("Agent 输出为空或超过 80,000 字符限制。");
      await this.updateStep(runId, step.id, {
        status: "completed",
        output,
        finishedAt: Date.now(),
      });
      return { stepId: step.id, sessionId: step.sessionId, output };
    } catch (error) {
      const cancelled = activeRun.abort.signal.aborted;
      const message = cancelled
        ? "Agent 步骤已取消。"
        : error instanceof FlowError
          ? error.message
          : "DSH Agent 执行失败或超时，请查看对应会话。";
      await this.updateStep(runId, step.id, {
        status: cancelled ? "cancelled" : "failed",
        error: message,
        finishedAt: Date.now(),
      });
      throw new FlowError(message);
    } finally {
      release?.();
    }
  }

  private updateStep(id: string, stepId: string, patch: Partial<FlowStep>) {
    return this.runs.update(id, (run) => ({
      ...run,
      steps: run.steps.map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    }));
  }

  async wait(id: string) {
    this.get(id);
    await this.running.get(id)?.task;
    return this.get(id);
  }

  async cancel(id: string) {
    this.get(id);
    const entry = this.running.get(id);
    if (entry) {
      entry.cancelRequested = true;
      entry.abort.abort(new Error("cancelled"));
      await entry.task;
    }
    return this.get(id);
  }

  async history(id: string, stepId: string, beforeSeq?: number) {
    const step = this.get(id).steps.find(
      (candidate) => candidate.id === stepId,
    );
    if (!step) throw new FlowError("Flow 步骤不存在。", 404);
    return this.sessions.history(step, beforeSeq);
  }

  async close() {
    this.closing = true;
    await this.admission;
    for (const entry of this.running.values()) {
      entry.cancelRequested = true;
      entry.abort.abort(new Error("runtime closing"));
    }
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.task),
    );
  }
}
