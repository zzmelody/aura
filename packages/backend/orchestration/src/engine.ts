import { randomUUID } from "node:crypto";
import {
  active,
  buildInput,
  defaultDefinition,
  definitionSchema,
  FlowError,
  parse,
  startSchema,
} from "./schema.ts";
import type {
  FlowDefinition,
  FlowRun,
  FlowStep,
  SavedFlowDefinition,
} from "@aura/protocol/types";
import type {
  EngineOptions,
  NodeDefinition,
  SessionPort,
  Table,
} from "./types.ts";

/** Backend-only scheduler. DSH owns agents, presets, transcripts and the store. */
export class FlowEngine {
  definitions: Table<SavedFlowDefinition>;
  runs: Table<FlowRun>;
  sessions: SessionPort;
  presets: EngineOptions["presets"];
  running = new Map<string, { abort: AbortController; task: Promise<void> }>();
  admission: Promise<unknown> = Promise.resolve();
  writes: Promise<unknown> = Promise.resolve();
  closing = false;
  constructor({ domain, sessions, presets }: EngineOptions) {
    this.definitions = domain.table("definitions");
    this.runs = domain.table("runs");
    this.sessions = sessions;
    this.presets = presets;
  }
  async initialize() {
    if (!this.definitions.get(defaultDefinition.id))
      await this.save(defaultDefinition);
    // Never replay tool side effects after an uncertain process termination.
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
  async catalog() {
    return {
      definitions: [...this.definitions.entries()].map(([, record]) => record),
      presets: await this.presets(),
    };
  }
  save(input: unknown) {
    const write = this.writes.then(() => this.persistDefinition(input));
    this.writes = write.catch(() => {});
    return write;
  }
  private async persistDefinition(input: unknown) {
    const definition = parse(definitionSchema, input);
    await this.validatePresets(definition);
    const old = this.definitions.get(definition.id);
    const record = {
      definition,
      revision: (old?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await this.definitions.put(definition.id, record);
    return record;
  }
  async validatePresets(definition: FlowDefinition) {
    const presets = new Map((await this.presets()).map((p) => [p.id, p]));
    for (const node of [...definition.nodes, definition.coordinator]) {
      if (!presets.has(node.preset) || presets.get(node.preset)!.unavailable)
        throw new FlowError(`Preset 不存在或不可用：${node.preset}`);
    }
  }
  list() {
    return [...this.runs.entries()]
      .map(([, run]) => ({
        id: run.id,
        name: run.definition.name,
        task: run.task,
        status: run.status,
        mode: run.mode,
        createdAt: run.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new FlowError("流程运行不存在。", 404);
    return run;
  }
  start(input: unknown) {
    const task = this.admission.then(() => this.admit(input));
    this.admission = task.catch(() => {});
    return task;
  }
  async admit(input: unknown) {
    const request = parse(startSchema, input);
    const previous = [...this.runs.entries()].find(
      ([, run]) => run.requestId === request.requestId,
    )?.[1];
    if (previous) {
      if (
        previous.definition.id !== request.definitionId ||
        previous.task !== request.task ||
        previous.mode !== request.mode
      )
        throw new FlowError("同一请求 ID 不能用于不同输入。", 409);
      return previous;
    }
    if (this.closing || this.running.size >= 2)
      throw new FlowError("已有两个流程在运行，请稍后再试。", 503);
    const saved = this.definitions.get(request.definitionId);
    if (!saved) throw new FlowError("流程定义不存在。", 404);
    await this.validatePresets(saved.definition);
    const definition = structuredClone(saved.definition);
    const run: FlowRun = {
      id: randomUUID(),
      requestId: request.requestId,
      definition,
      revision: saved.revision,
      task: request.task,
      mode: request.mode,
      status: "queued",
      createdAt: Date.now(),
      steps: [
        ...definition.nodes,
        { id: "coordinator", label: "最终报告", ...definition.coordinator },
      ].map(({ id, label, preset }) => ({
        id,
        label,
        preset,
        sessionId: randomUUID(),
        status: "queued",
      })),
    };
    await this.runs.put(run.id, run);
    const abort = new AbortController();
    const entry = { abort, task: Promise.resolve() };
    this.running.set(run.id, entry);
    entry.task = this.execute(run.id, abort.signal)
      .catch(async () => {
        abort.abort();
        await this.runs.update(run.id, (r) => ({
          ...r,
          status: "failed",
          finishedAt: Date.now(),
          error: "流程状态提交失败，请检查后端存储。",
          steps: r.steps.map((step) =>
            active(step.status)
              ? { ...step, status: "interrupted", finishedAt: Date.now() }
              : step,
          ),
        }));
      })
      .finally(() => this.running.delete(run.id));
    entry.task.catch(() => {});
    return run;
  }
  updateStep(id: string, stepId: string, patch: Partial<FlowStep>) {
    return this.runs.update(id, (run) => ({
      ...run,
      steps: run.steps.map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    }));
  }
  async execute(id: string, signal: AbortSignal) {
    await this.runs.update(id, (run) => ({ ...run, status: "running" }));
    const definition = this.get(id).definition;
    const inflight = new Map<string, Promise<void>>();
    const pending = new Map(definition.nodes.map((node) => [node.id, node]));
    let failed = false;
    const launch = (node: NodeDefinition, sources: string[]) => {
      const task = this.executeStep(id, node, sources, signal).then((ok) => {
        if (!ok) failed = true;
      });
      inflight.set(
        node.id,
        task.finally(() => inflight.delete(node.id)),
      );
    };
    try {
      while (pending.size || inflight.size) {
        if (!failed && !signal.aborted)
          for (const [key, node] of pending) {
            if (inflight.size >= definition.concurrency) break;
            const steps = this.get(id).steps;
            if (
              node.dependsOn.every(
                (dep) =>
                  steps.find((step) => step.id === dep)!.status === "completed",
              )
            ) {
              pending.delete(key);
              launch(node, node.dependsOn);
            }
          }
        if (!inflight.size) break;
        await Promise.race(inflight.values());
      }
      if (!failed && !signal.aborted) {
        const ok = await this.executeStep(
          id,
          { id: "coordinator", ...definition.coordinator },
          definition.coordinator.sources,
          signal,
        );
        failed = !ok;
      }
      const status = signal.aborted
        ? "cancelled"
        : failed
          ? "failed"
          : "completed";
      await this.runs.update(id, (run) => ({
        ...run,
        status,
        finishedAt: Date.now(),
        ...(status === "completed"
          ? { report: run.steps.find((s) => s.id === "coordinator")!.output }
          : {}),
        steps: run.steps.map((step) =>
          step.status === "queued"
            ? {
                ...step,
                status: signal.aborted ? "cancelled" : "skipped",
                finishedAt: Date.now(),
              }
            : step,
        ),
      }));
    } catch (error) {
      this.running.get(id)?.abort.abort();
      await Promise.allSettled(inflight.values());
      throw error;
    }
  }
  async executeStep(
    id: string,
    node: { id: string; prompt: string },
    sources: string[],
    signal: AbortSignal,
  ) {
    if (signal.aborted) return false;
    const run = this.get(id);
    const step = run.steps.find((s) => s.id === node.id)!;
    try {
      await this.updateStep(id, step.id, {
        status: "running",
        startedAt: Date.now(),
      });
      const input = buildInput(
        run,
        node,
        sources.map((key) => run.steps.find((s) => s.id === key)!),
      );
      const output = await this.sessions.execute({
        ...step,
        input,
        mode: run.mode,
        timeoutMs: run.definition.timeoutMs,
        signal,
      });
      if (signal.aborted) throw new Error("cancelled");
      if (!output.trim() || output.length > 80000)
        throw new FlowError("节点输出为空或超过 80,000 字符限制。");
      await this.updateStep(id, step.id, {
        status: "completed",
        output,
        finishedAt: Date.now(),
      });
      return true;
    } catch (error) {
      await this.updateStep(id, step.id, {
        status: signal.aborted ? "cancelled" : "failed",
        finishedAt: Date.now(),
        error:
          error instanceof FlowError
            ? error.message
            : "DSH 节点执行失败、超时或被中断。请检查登录、preset 和会话记录。",
      });
      return false;
    }
  }
  async cancel(id: string) {
    this.get(id);
    const entry = this.running.get(id);
    entry?.abort.abort();
    if (entry) await entry.task;
    return this.get(id);
  }
  async history(id: string, stepId: string, beforeSeq?: number) {
    const step = this.get(id).steps.find((s) => s.id === stepId);
    if (!step) throw new FlowError("流程步骤不存在。", 404);
    return this.sessions.history(step, beforeSeq);
  }
  async close() {
    this.closing = true;
    await this.admission;
    await this.writes;
    for (const entry of this.running.values()) entry.abort.abort();
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.task),
    );
  }
}
