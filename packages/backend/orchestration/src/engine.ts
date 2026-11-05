import { compatibleRevision } from "./plugin-compatibility.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FlowRun,
  FlowStep,
  FlowCatalog,
  FlowAgentStep,
  FlowChildStep,
  AuraPluginIdentity,
  AuraPluginStatus,
} from "@aura/protocol/types";
import type { EngineOptions, Table } from "./types.ts";
import type { LoadedFlow } from "./registry.ts";
import type { LoadedAction } from "./action-registry.ts";
import {
  FlowError,
  parse,
  parseJson,
  startSchema,
  jsonValue,
} from "./schema.ts";
import {
  executable,
  fingerprint,
  stepKey,
  StorageFailure,
  terminal,
  validateSaved,
} from "./durable.ts";
import { FlowExecution } from "./execution.ts";
import { FlowScheduler } from "./scheduler.ts";
import { recoverRun } from "./recovery.ts";
import { agentDefaults, agentConfig } from "@aura/dsh-auth/model-config";
import { FLOW_TIMEOUT_MS } from "./timeouts.ts";

const MAX_NESTED_FLOW_DEPTH = 8;

function samePlugin(
  left: LoadedFlow["plugin"] | LoadedAction["plugin"],
  right: LoadedFlow["plugin"] | LoadedAction["plugin"],
) {
  return (
    left?.id === right?.id &&
    left?.version === right?.version &&
    Boolean(left) === Boolean(right)
  );
}

const mutationSchema = z
  .object({
    requestId: z.uuid(),
    action: z.enum(["retry", "submit_output", "terminate"]).optional(),
    output: z.unknown().optional(),
  })
  .strict();
type Operation = "pause" | "resume" | "cancel" | "answer" | "resolve";
type Revision = {
  flow: LoadedFlow;
  actions: ReadonlyMap<string, LoadedAction>;
  pluginEpochs: ReadonlyMap<string, number>;
};

/** Public engine facade; durable records own both queue admission and command receipts. */
export class FlowEngine {
  readonly runs: Table<FlowRun>;
  readonly running = new Map<string, FlowExecution>();
  private options: EngineOptions;
  private scheduler: FlowScheduler;
  private nestedTasks = new Map<string, Promise<void>>();
  private revisions = new Map<string, Revision>();
  private pluginEpochs = new Map<string, number>();
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private initialized = false;
  private storageFailures = new Set<string>();
  private queueTime() {
    return Math.max(
      Date.now(),
      ...[...this.runs.entries()].map(([, run]) => (run.queuedAt ?? 0) + 1),
    );
  }
  constructor(options: EngineOptions) {
    this.options = options;
    this.runs = options.domain.table("runs");
    this.scheduler = new FlowScheduler(
      () =>
        [...this.runs.entries()]
          .map(([, run]) => run)
          .filter(
            (run) =>
              run.status === "queued" &&
              !run.parent &&
              !this.storageFailures.has(run.id),
          )
          .sort(
            (a, b) =>
              (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
              a.id.localeCompare(b.id),
          )
          .map((run) => run.id),
      (id) => this.execute(id),
    );
  }
  private settling = new Set<string>();
  private settlements: Promise<unknown> = Promise.resolve();
  /** Notifies the owner once per terminal root Run, including after a restart. */
  private settleLater(run: FlowRun) {
    if (
      !this.options.onRootSettled ||
      run.parent ||
      run.settledAt !== undefined ||
      !terminal(run.status) ||
      this.settling.has(run.id)
    )
      return;
    this.settling.add(run.id);
    this.settlements = this.settlements.then(async () => {
      try {
        await this.options.onRootSettled!(run);
        await this.runs.update(run.id, (current) => ({
          ...current,
          settledAt: Date.now(),
        }));
      } catch {
        // The provider manager logs its own failures; storage failures retry on restart.
      } finally {
        this.settling.delete(run.id);
      }
    });
  }
  /** Stores a small last-wins progress value on the Run tree's root. */
  private async report(id: string, value: unknown) {
    const report = jsonValue(value, "Flow 进度", 4 * 1_024);
    const run = this.get(id);
    await this.update(run.rootRunId ?? run.id, (current) => ({
      ...current,
      report,
    }));
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.operations.then(work);
    this.operations = task.catch(() => undefined);
    return task;
  }
  private async update(id: string, change: (run: FlowRun) => FlowRun) {
    try {
      const run = await this.runs.update(id, (current) => ({
        ...change(current),
        updatedAt: Date.now(),
      }));
      this.scheduler.notify();
      this.settleLater(run);
      return run;
    } catch (error) {
      this.storageFailures.add(id);
      throw new StorageFailure(error);
    }
  }
  async initialize(options: { discovered?: boolean } = {}) {
    if (this.initialized) return;
    if (!options.discovered) await this.options.refreshFlows();
    for (const [id, run] of this.runs.entries()) {
      if (!executable(run.status)) continue;
      if (run.durableVersion && !(await this.revision(id))) continue;
      const recovered = await recoverRun(run, this.options.sessions);
      await this.update(id, () => recovered);
    }
    for (const [id, run] of this.runs.entries()) {
      if (!run.parent || terminal(run.status)) continue;
      const parent = this.runs.get(run.parent.runId);
      if (parent && !terminal(parent.status)) continue;
      await this.update(id, (current) => ({
        ...current,
        status: "cancelled",
        finishedAt: Date.now(),
        error: "父 Flow 已结束，子 Flow 已取消。",
      }));
    }
    for (const [, run] of this.runs.entries()) this.settleLater(run);
    this.initialized = true;
    this.scheduler.kick();
  }
  async catalog(): Promise<FlowCatalog> {
    // Discovery and HMR maintain the registry; reads must not rescan disk.
    return {
      flows: this.options.registry.catalog(),
      actions: this.options.actions?.registry.catalog() ?? [],
      plugins: this.options.plugins ?? [],
      presets: await this.options.presets(),
    };
  }
  setPlugins(plugins: AuraPluginStatus[], changedPluginIds: string[] = []) {
    for (const id of changedPluginIds)
      this.pluginEpochs.set(id, (this.pluginEpochs.get(id) ?? 0) + 1);
    this.options.plugins = plugins;
  }
  list() {
    return [...this.runs.entries()]
      .filter(([, run]) => !run.parent)
      .map(([, run]) => ({
        id: run.id,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        flowId: run.flow.id,
        title: run.flow.title,
        inputPreview:
          JSON.stringify(run.input).length > 140
            ? `${JSON.stringify(run.input).slice(0, 137)}…`
            : JSON.stringify(run.input),
        status: run.status,
        mode: run.mode,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new FlowError("Flow 运行不存在。", 404);
    return run;
  }
  associateConversation(id: string, conversationId: string) {
    return this.serialize(async () => {
      const run = this.get(id);
      if (run.conversationId && run.conversationId !== conversationId)
        throw new FlowError("工作流已属于另一段对话。", 409);
      if (!run.conversationId)
        await this.runs.update(id, (current) => ({
          ...current,
          conversationId,
        }));
    });
  }
  start(input: unknown, conversationId?: string) {
    return this.serialize(async () => {
      if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
      const request = parse(startSchema, input);
      if (request.useConfiguredModel && !request.serviceOnly)
        throw new FlowError("模型默认选择仅供受控服务使用。", 403);
      let publishedFlow: LoadedFlow | undefined;
      if (request.serviceOnly) {
        await this.options.refreshFlows();
        publishedFlow = this.options.registry.get(request.flowId);
        if (!publishedFlow.service)
          throw new FlowError(
            `Flow 未发布为 HTTP 服务：${request.flowId}`,
            404,
          );
      }
      const previous = [...this.runs.entries()].find(
        ([, run]) => run.requestId === request.requestId,
      )?.[1];
      if (previous) {
        if (
          (conversationId &&
            previous.conversationId &&
            previous.conversationId !== conversationId) ||
          previous.flow.id !== request.flowId ||
          (!request.useConfiguredModel && previous.mode !== request.mode) ||
          (previous.requestInputHash ?? fingerprint(previous.input)) !==
            fingerprint(jsonValue(request.input, "Flow 入参"))
        )
          throw new FlowError("同一请求 ID 不能用于不同输入。", 409);
        return previous;
      }
      if (!publishedFlow) await this.options.refreshFlows();
      const flow = publishedFlow ?? this.options.registry.get(request.flowId);
      const args = parseJson(flow.inputSchema, request.input, "Flow 入参");
      const defaults = this.options.resolveAgentDefaults
        ? agentConfig(
            {
              ...(await this.options.resolveAgentDefaults(
                request.useConfiguredModel ? "configured" : request.mode,
              )),
              timeoutMs: flow.agentTimeoutMs,
            },
            flow.agentDefaults ?? {},
          )
        : agentDefaults(request.mode, flow.agentDefaults, flow.agentTimeoutMs);
      const actions = new Map(this.options.actions?.registry.snapshot() ?? []);
      const run: FlowRun = {
        id: randomUUID(),
        requestId: request.requestId,
        ...(conversationId ? { conversationId } : {}),
        flow: {
          id: flow.id,
          title: flow.title,
          description: flow.description,
          plugin: flow.plugin,
        },
        input: args,
        mode: request.useConfiguredModel
          ? defaults.provider === "openai-codex"
            ? "codex"
            : "custom"
          : request.mode,
        status: "queued",
        createdAt: Date.now(),
        queuedAt: this.queueTime(),
        updatedAt: Date.now(),
        steps: [],
        durableVersion: 1,
        agentDefaults: defaults,
        requestInputHash: fingerprint(jsonValue(request.input, "Flow 入参")),
        actionVersions: [...actions.values()].map(({ id, plugin }) => ({
          id,
          plugin,
        })),
      };
      await this.runs.put(run.id, run);
      this.revisions.set(run.id, {
        flow,
        actions,
        pluginEpochs: new Map(this.pluginEpochs),
      });
      this.scheduler.kick();
      return run;
    });
  }
  private async resolveChild(
    parentRunId: string,
    flowId: string,
    input: unknown,
  ) {
    await this.options.refreshFlows();
    const parent = this.get(parentRunId);
    const caller = this.revisions.get(parentRunId)?.flow;
    if (!caller)
      throw new FlowError("父 Flow 的固定版本不可用，无法启动子 Flow。", 409);
    const flow = this.options.registry.get(flowId);
    const callerPlugin = caller.ownerPlugin ?? caller.plugin;
    const sameOwner =
      Boolean(callerPlugin) && callerPlugin?.id === flow.plugin?.id;
    if (
      callerPlugin &&
      !sameOwner &&
      !caller.permissions.includes("aura.flow.invoke")
    )
      throw new FlowError(
        `插件 Flow ${caller.id} 缺少跨插件调用能力 aura.flow.invoke。`,
        403,
      );
    const ancestry = [...(parent.ancestry ?? []), parent.flow.id];
    if (ancestry.includes(flow.id))
      throw new FlowError(
        `检测到 Flow 循环调用：${[...ancestry, flow.id].join(" -> ")}`,
        409,
      );
    if (ancestry.length > MAX_NESTED_FLOW_DEPTH)
      throw new FlowError(`Flow 嵌套最多 ${MAX_NESTED_FLOW_DEPTH} 层。`, 409);
    return {
      id: flow.id,
      title: flow.title,
      plugin: flow.plugin,
      input: parseJson(flow.inputSchema, input, "子 Flow 入参"),
      outputSchema: jsonValue(
        JSON.parse(JSON.stringify(z.toJSONSchema(flow.outputSchema))),
        "子 Flow 出参 Schema",
      ),
    };
  }
  private startChild(parentRunId: string, step: FlowChildStep) {
    return this.serialize(async () => {
      if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
      const parent = this.get(parentRunId);
      if (terminal(parent.status))
        throw new FlowError("父 Flow 已结束，不能再启动子 Flow。", 409);
      const saved = parent.steps.find(
        (candidate) => candidate.stepKey === step.stepKey,
      );
      if (
        saved?.kind !== "flow" ||
        saved.childRequestId !== step.childRequestId
      )
        throw new FlowError("父 Flow 步骤与子 Flow 启动请求不一致。", 409);
      const previous = [...this.runs.entries()].find(
        ([, run]) => run.requestId === step.childRequestId,
      )?.[1];
      if (previous) {
        if (
          previous.parent?.runId !== parentRunId ||
          previous.parent.stepKey !== step.stepKey ||
          previous.flow.id !== step.flowId ||
          previous.requestInputHash !== step.requestInputHash
        )
          throw new FlowError("子 Flow 请求 ID 已用于不同调用。", 409);
        if (saved.childRunId !== previous.id)
          await this.update(parentRunId, (current) => ({
            ...current,
            steps: current.steps.map((candidate) =>
              candidate.kind === "flow" && candidate.stepKey === step.stepKey
                ? { ...candidate, childRunId: previous.id }
                : candidate,
            ),
          }));
        return previous;
      }
      await this.options.refreshFlows();
      const flow = compatibleRevision(
        this.options.registry.get(step.flowId),
        step,
      );
      if (!samePlugin(flow.plugin, step.plugin))
        throw new FlowError(
          `子 Flow ${step.flowId} 的固定版本已不可用，请新建运行。`,
          409,
        );
      const actions = new Map(this.options.actions?.registry.snapshot() ?? []);
      for (const ref of parent.actionVersions ?? []) {
        const action = actions.get(ref.id);
        if (action) actions.set(ref.id, compatibleRevision(action, ref));
      }
      const now = Date.now();
      const run: FlowRun = {
        id: randomUUID(),
        requestId: step.childRequestId,
        flow: {
          id: flow.id,
          title: flow.title,
          description: flow.description,
          plugin: flow.plugin,
        },
        input: step.input,
        mode: parent.mode,
        status: "queued",
        createdAt: now,
        queuedAt: now,
        updatedAt: now,
        steps: [],
        durableVersion: 1,
        agentDefaults: parent.agentDefaults
          ? agentConfig(
              { ...parent.agentDefaults, timeoutMs: flow.agentTimeoutMs },
              flow.agentDefaults ?? {},
            )
          : agentDefaults(parent.mode, flow.agentDefaults, flow.agentTimeoutMs),
        requestInputHash: step.requestInputHash,
        actionVersions: [...actions.values()].map(({ id, plugin }) => ({
          id,
          plugin,
        })),
        parent: { runId: parentRunId, stepKey: step.stepKey! },
        rootRunId: parent.rootRunId ?? parent.id,
        ancestry: [...(parent.ancestry ?? []), parent.flow.id],
      };
      await this.runs.put(run.id, run);
      await this.update(parentRunId, (current) => ({
        ...current,
        steps: current.steps.map((candidate) =>
          candidate.kind === "flow" && candidate.stepKey === step.stepKey
            ? { ...candidate, childRunId: run.id }
            : candidate,
        ),
      }));
      this.revisions.set(run.id, {
        flow,
        actions,
        pluginEpochs: new Map(this.pluginEpochs),
      });
      return run;
    });
  }
  private async runChild(id: string): Promise<FlowRun> {
    let run = this.get(id);
    if (!run.parent)
      throw new FlowError("只有嵌套 Flow Run 可以由父 Flow 内联执行。", 409);
    if (run.status === "paused") {
      run = await this.update(id, (current) => ({
        ...current,
        status: "queued",
        queuedAt: this.queueTime(),
        finishedAt: undefined,
        error: undefined,
      }));
    }
    if (!executable(run.status)) return run;
    let task = this.nestedTasks.get(id);
    if (!task) {
      task = Promise.resolve()
        .then(() => this.execute(id))
        .finally(() => this.nestedTasks.delete(id));
      this.nestedTasks.set(id, task);
    }
    await task;
    return this.get(id);
  }
  private async revision(
    id: string,
    rejectedCommand?: { requestId: string; fingerprint: string },
  ): Promise<Revision | undefined> {
    const pinned = this.revisions.get(id);
    const run = this.get(id);
    const pluginDetached = (plugin: AuraPluginIdentity | undefined) =>
      Boolean(plugin) &&
      Boolean(pinned) &&
      (pinned!.pluginEpochs.get(plugin!.id) !==
        (this.pluginEpochs.get(plugin!.id) ?? 0) ||
        !this.options.plugins?.some(
          (status) =>
            status.enabled &&
            status.available &&
            status.id === plugin!.id &&
            status.version === plugin!.version,
        ));
    const missingConfig =
      Boolean(run.durableVersion) &&
      (!run.agentDefaults ||
        run.steps.some(
          (step) => (!step.kind || step.kind === "agent") && !step.config,
        ));
    try {
      if (missingConfig) throw new Error("Missing pinned Agent configuration");
      let flow: LoadedFlow;
      try {
        flow = compatibleRevision(
          this.options.registry.get(run.flow.id),
          run.flow,
        );
      } catch (error) {
        if (
          pinned &&
          pluginDetached(pinned?.flow.ownerPlugin ?? run.flow.plugin)
        )
          return pinned;
        throw error;
      }
      const actions = new Map(this.options.actions?.registry.snapshot() ?? []);
      for (const ref of run.actionVersions ?? []) {
        const action = actions.get(ref.id);
        if (action) actions.set(ref.id, compatibleRevision(action, ref));
      }
      if (!samePlugin(flow.plugin, run.flow.plugin)) {
        if (
          pinned &&
          pluginDetached(pinned?.flow.ownerPlugin ?? run.flow.plugin)
        )
          return pinned;
        throw new Error("Flow");
      }
      let usePinned = Boolean(
        pinned &&
        run.actionVersions?.some(({ id, plugin }) =>
          pluginDetached(pinned?.actions.get(id)?.ownerPlugin ?? plugin),
        ),
      );
      for (const step of run.steps) {
        const refs =
          step.kind === "action"
            ? [
                {
                  id: step.actionId,
                  sourceHash: step.sourceHash,
                  plugin: step.plugin,
                },
              ]
            : step.kind === "agent" || step.kind === undefined
              ? (step.actions ?? [])
              : [];
        for (const ref of refs) {
          if (
            !actions.has(ref.id) ||
            !samePlugin(actions.get(ref.id)?.plugin, ref.plugin)
          ) {
            const pinnedAction = pinned?.actions.get(ref.id);
            if (
              pinnedAction &&
              samePlugin(pinnedAction.plugin, ref.plugin) &&
              pluginDetached(pinnedAction.ownerPlugin ?? ref.plugin)
            ) {
              usePinned = true;
              continue;
            }
            throw new Error("Action");
          }
        }
      }
      return usePinned
        ? pinned
        : { flow, actions, pluginEpochs: new Map(this.pluginEpochs) };
    } catch {
      await this.update(id, (current) => ({
        ...current,
        status: "interrupted",
        finishedAt: Date.now(),
        error: missingConfig
          ? "agent_config_unrecoverable: 旧运行未保存 Agent 模型配置，无法保证恢复时配置一致，请新建运行。"
          : "revision_mismatch: Flow 或已引用 Action 不可用，或插件身份已变化，请新建运行。",
        commands: rejectedCommand
          ? [
              ...(current.commands ?? []),
              { ...rejectedCommand, status: "interrupted", at: Date.now() },
            ]
          : current.commands,
      }));
      return undefined;
    }
  }
  private async execute(id: string) {
    if (this.closed || this.get(id).status !== "queued") return;
    const revision = await this.revision(id);
    if (!revision || this.closed || this.get(id).status !== "queued") return;
    // Recovery reconstructs a revision without start()/startChild(). Pin it before
    // resumed code resolves a not-yet-created child or grandchild Flow.
    this.revisions.set(id, revision);
    const execution = new FlowExecution({
      ...revision,
      ports: this.options,
      flows: {
        resolve: (parentRunId, flowId, input) =>
          this.resolveChild(parentRunId, flowId, input),
        start: (parentRunId, step) => this.startChild(parentRunId, step),
        run: (runId) => this.runChild(runId),
      },
      get: () => this.get(id),
      update: (change) => this.update(id, change),
      report: (value) => this.report(id, value),
    });
    this.running.set(id, execution);
    const expireTree = (runId: string) => {
      this.running.get(runId)?.expire();
      for (const childId of this.childRunIds(this.get(runId)))
        expireTree(childId);
    };
    const deadline = setTimeout(() => expireTree(id), FLOW_TIMEOUT_MS);
    deadline.unref();
    try {
      await execution.run();
    } finally {
      clearTimeout(deadline);
      this.running.delete(id);
      if (terminal(this.get(id).status)) this.revisions.delete(id);
      this.scheduler.notify();
    }
  }
  storageIssue(id: string): string | undefined {
    if (this.storageFailures.has(id))
      return "Flow 状态存档失败，请修复存储并重启运行时恢复。";
  }
  async wait(id: string) {
    while (executable(this.get(id).status)) {
      const issue = this.storageIssue(id);
      if (issue) throw new FlowError(issue, 503);
      if (this.closed) break;
      if (this.get(id).parent && this.get(id).status === "queued") {
        await this.runChild(id);
        continue;
      }
      const changed = this.scheduler.changed();
      this.scheduler.kick();
      await changed;
    }
    return this.get(id);
  }
  private childRunIds(run: FlowRun) {
    return run.steps.flatMap((step) =>
      step.kind === "flow" && step.childRunId ? [step.childRunId] : [],
    );
  }
  private async wakeAncestors(child: FlowRun, paused: boolean) {
    let current = child;
    while (current.parent) {
      const parentId = current.parent.runId;
      const parent = this.get(parentId);
      if (terminal(parent.status)) break;
      let pauseExecution = false;
      const updated = await this.serialize(() =>
        this.update(parentId, (latest) => {
          if (terminal(latest.status)) return latest;
          if (paused) {
            pauseExecution = this.running.has(parentId);
            return {
              ...latest,
              status:
                latest.status === "paused"
                  ? "paused"
                  : pauseExecution
                    ? "pausing"
                    : "paused",
            };
          }
          return {
            ...latest,
            status: "queued",
            queuedAt: this.queueTime(),
            finishedAt: undefined,
            error: undefined,
            steps: latest.steps.map((step) =>
              step.kind === "flow" && step.childRunId === current.id
                ? { ...step, status: "queued", error: undefined }
                : step,
            ),
          };
        }),
      );
      if (pauseExecution) this.running.get(parentId)?.pause();
      current = updated;
    }
    this.scheduler.kick();
  }
  async command(
    id: string,
    operation: Operation,
    input: unknown,
    key?: string,
  ) {
    const request = parse(mutationSchema, input);
    if ((operation === "answer" || operation === "resolve") && !key)
      throw new FlowError("缺少 stepKey。");
    if (operation === "resolve" && !request.action)
      throw new FlowError("缺少处理方式。");
    if (request.action && operation !== "resolve")
      throw new FlowError("此操作不接受 action。");
    const bodyHash = fingerprint({ operation, key, ...request });
    let stateChanged = false;
    const result = await this.serialize(async () => {
      if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
      const current = this.get(id);
      const receipt = current.commands?.find(
        (item) => item.requestId === request.requestId,
      );
      if (receipt) {
        if (receipt.fingerprint !== bodyHash)
          throw new FlowError("同一请求 ID 不能用于不同操作。", 409);
        return current;
      }
      if (terminal(current.status) && operation !== "cancel")
        throw new FlowError("此运行已结束，请新建运行。", 409);
      if (operation === "resume") {
        if (current.status !== "paused")
          throw new FlowError("仅 paused 运行可以恢复。", 409);
        await this.options.refreshFlows();
        if (
          !(await this.revision(id, {
            requestId: request.requestId,
            fingerprint: bodyHash,
          }))
        ) {
          stateChanged = true;
          return this.get(id);
        }
      }
      let next = current;
      if (operation === "pause") {
        if (
          !["queued", "running", "pausing", "paused"].includes(current.status)
        )
          throw new FlowError("当前状态不能暂停。", 409);
        next = {
          ...current,
          status:
            current.status !== "paused" && this.running.has(id)
              ? "pausing"
              : "paused",
        };
        stateChanged = current.status !== "paused";
      }
      if (operation === "resume") {
        next = { ...current, status: "queued", queuedAt: this.queueTime() };
        stateChanged = true;
      }
      if (operation === "cancel") {
        next = terminal(current.status)
          ? current
          : {
              ...current,
              status: "cancelled",
              finishedAt: Date.now(),
              error: "Flow 已取消。",
            };
        stateChanged = !terminal(current.status);
      }
      if (operation === "answer" || operation === "resolve") {
        const step = current.steps.find((step) => stepKey(step) === key);
        if (!step) throw new FlowError("Flow 步骤不存在。", 404);
        if (step.kind === "flow")
          throw new FlowError(
            "请在 childRunId 对应的子 Flow Run 上处理输入或未知结果。",
            409,
          );
        if (
          operation === "answer" &&
          (current.status !== "waiting_input" ||
            step.kind !== "checkpoint" ||
            step.status !== "waiting_input")
        )
          throw new FlowError("该 checkpoint 当前不等待输入。", 409);
        if (
          operation === "resolve" &&
          (current.status !== "needs_attention" || step.status !== "unknown")
        )
          throw new FlowError("该步骤当前不等待人工处理。", 409);
        let changed: FlowStep = step;
        if (operation === "answer" || request.action === "submit_output") {
          const output =
            step.kind === "agent" || step.kind === undefined
              ? parseJson(
                  z.string().trim().min(1).max(80_000),
                  request.output,
                  "Agent 输出",
                )
              : validateSaved(
                  "outputSchema" in step ? (step.outputSchema ?? {}) : {},
                  request.output,
                );
          changed = {
            ...step,
            status: "completed",
            output,
            finishedAt: Date.now(),
            error: undefined,
          } as FlowStep;
        }
        if (request.action === "retry")
          changed = {
            ...step,
            status: "queued",
            error: undefined,
            nextAttemptAt: undefined,
            extraAttempts: (step.extraAttempts ?? 0) + 1,
          };
        changed = {
          ...changed,
          recoveryEvents: [
            ...(step.recoveryEvents ?? []),
            {
              at: Date.now(),
              requestId: request.requestId,
              ...(request.action ? { action: request.action } : {}),
              reason:
                operation === "answer"
                  ? "已提交 checkpoint 答案。"
                  : `人工处理：${request.action}`,
            },
          ],
        };
        const steps = current.steps.map((item) =>
          stepKey(item) === key ? changed : item,
        );
        next = {
          ...current,
          steps,
          error: undefined,
          status:
            request.action === "terminate"
              ? "cancelled"
              : steps.some((item) => item.status === "unknown")
                ? "needs_attention"
                : "queued",
          queuedAt: this.queueTime(),
          finishedAt: request.action === "terminate" ? Date.now() : undefined,
        };
        stateChanged = true;
      }
      // Step completions may interleave with pause/cancel. Preserve their latest records.
      const updated = await this.update(id, (latest) => {
        if (
          (operation === "pause" || operation === "cancel") &&
          terminal(latest.status)
        )
          next = latest;
        return {
          ...latest,
          status: next.status,
          queuedAt: next.queuedAt,
          finishedAt: next.finishedAt,
          error: next.error,
          ...(operation === "answer" || operation === "resolve"
            ? { steps: next.steps }
            : {}),
          commands: [
            ...(latest.commands ?? []),
            {
              requestId: request.requestId,
              fingerprint: bodyHash,
              status: next.status,
              at: Date.now(),
            },
          ],
        };
      });
      if (operation === "pause" && updated.status === "pausing")
        this.running.get(id)?.pause();
      if (operation === "cancel" || request.action === "terminate") {
        const execution = this.running.get(id);
        if (execution) {
          execution.cancelRequested = true;
          execution.abort.abort(new Error("cancelled"));
        } else this.revisions.delete(id);
      }
      this.scheduler.kick();
      return updated;
    });
    if (stateChanged && (operation === "pause" || operation === "cancel")) {
      await Promise.all(
        this.childRunIds(result).map((childId) =>
          this.command(childId, operation, { requestId: randomUUID() }),
        ),
      );
    }
    const settled = this.get(id);
    if (stateChanged && settled.parent)
      await this.wakeAncestors(settled, operation === "pause");
    if (operation === "cancel") {
      await Promise.allSettled(
        [this.scheduler.running.get(id), this.nestedTasks.get(id)].filter(
          (task): task is Promise<void> => Boolean(task),
        ),
      );
      return this.get(id);
    }
    return result;
  }
  pause(id: string, requestId = randomUUID()) {
    return this.command(id, "pause", { requestId });
  }
  resume(id: string, requestId = randomUUID()) {
    return this.command(id, "resume", { requestId });
  }
  cancel(id: string, requestId = randomUUID()) {
    return this.command(id, "cancel", { requestId });
  }
  async history(
    id: string,
    key: string,
    beforeSeq?: number,
    attemptNumber?: number,
  ) {
    const step = this.get(id).steps.find(
      (candidate) =>
        stepKey(candidate) === key ||
        (!candidate.stepKey && candidate.id === key),
    );
    if (!step) throw new FlowError("Flow 步骤不存在。", 404);
    if (step.kind && step.kind !== "agent")
      throw new FlowError(
        "该步骤没有 DSH session，请读取结构化输入和输出。",
        400,
      );
    let agent = step as FlowAgentStep;
    if (attemptNumber !== undefined) {
      const attempt = step.attempts?.find(
        (value) => value.number === attemptNumber,
      );
      if (!attempt?.sessionId)
        throw new FlowError("Agent attempt 不存在。", 404);
      agent = {
        ...agent,
        sessionId: attempt.sessionId,
        startedAt: attempt.startedAt,
      };
    }
    return this.options.sessions.history(agent, beforeSeq);
  }
  async close() {
    this.closed = true;
    this.scheduler.stop();
    await this.operations;
    for (const execution of this.running.values()) {
      execution.closing = true;
      execution.abort.abort(new Error("runtime closing"));
    }
    await Promise.allSettled([...this.scheduler.running.values()]);
    await Promise.allSettled([...this.nestedTasks.values()]);
    await this.settlements;
  }
}
