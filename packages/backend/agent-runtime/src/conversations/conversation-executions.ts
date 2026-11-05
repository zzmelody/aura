import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FlowError } from "@aura/protocol/errors";
import { isExecutionActive } from "@aura/protocol/conversation-channel";
import type {
  ConversationCommand,
  ConversationExecution,
  ConversationReceipt,
  ConversationSnapshot,
} from "@aura/protocol/conversation-channel";
import type { CodingHistoryPage } from "@aura/protocol/types";
import type { CodingStreamEvent, Table } from "../types.ts";
import {
  commandDigest,
  commandKey,
  type ConversationCommandRecord,
} from "./conversation-commands.ts";
import { ConversationEvents } from "./conversation-events.ts";

type StartCommand = Extract<ConversationCommand, { type: "turn.start" }>;
type ControlCommand = Exclude<ConversationCommand, StartCommand>;
interface Execution {
  state: ConversationExecution;
  abort: AbortController;
  done: Promise<void>;
  finish(): void;
  turnId?: string;
}
interface Ports {
  assertSession(id: string): void;
  start(
    id: string,
    command: StartCommand,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }>;
  control(id: string, command: ControlCommand): Promise<void>;
  history(id: string): Promise<CodingHistoryPage>;
}

/** Owns execution, while HTTP/RPC clients only submit commands and observe it. */
export class ConversationExecutions {
  readonly events = new ConversationEvents();
  private readonly epoch = randomUUID();
  private readonly active = new Map<string, Execution>();
  private readonly latest = new Map<string, string>();
  private readonly pending = new Map<string, Promise<ConversationReceipt>>();
  private readonly receipts = new Map<string, ConversationCommandRecord>();
  private readonly dispatches = new Set<Promise<void>>();
  private closed = false;

  private readonly table: Table<ConversationCommandRecord>;
  private readonly ports: Ports;
  constructor(table: Table<ConversationCommandRecord>, ports: Ports) {
    this.table = table;
    this.ports = ports;
    for (const [key, record] of table.entries()) {
      if (!record.receipt.execution) continue;
      const previousKey = this.latest.get(record.receipt.sessionId);
      const previous = previousKey
        ? table.get(previousKey)?.receipt.execution
        : undefined;
      if (!previous || previous.startedAt <= record.receipt.execution.startedAt)
        this.latest.set(record.receipt.sessionId, key);
    }
  }

  private record(key: string): ConversationCommandRecord | undefined {
    return this.receipts.get(key) ?? this.table.get(key);
  }

  private project(record: ConversationCommandRecord): ConversationReceipt {
    const receipt = structuredClone(record.receipt);
    if (record.epoch !== this.epoch) {
      if (receipt.status === "accepted") receipt.status = "uncertain";
      if (isExecutionActive(receipt.execution))
        receipt.execution = {
          ...receipt.execution!,
          status: "interrupted",
          error: "执行宿主已重启，请检查已完成的工作后决定是否继续。",
        };
    }
    return receipt;
  }

  receipt(id: string, commandId: string): ConversationReceipt {
    const record = this.record(commandKey(id, commandId));
    if (!record) throw new FlowError("尚未找到这条命令的接收记录。", 404);
    const receipt = this.project(record);
    const live = this.active.get(id);
    if (receipt.execution && live?.state.id === receipt.executionId)
      receipt.execution = this.liveState(live);
    return receipt;
  }

  execution(id: string): ConversationExecution | undefined {
    const active = this.active.get(id);
    if (active) return this.liveState(active);
    const key = this.latest.get(id);
    const record = key ? this.record(key) : undefined;
    return record ? this.project(record).execution : undefined;
  }

  private liveState(execution: Execution): ConversationExecution {
    const state = structuredClone(execution.state);
    // Settlement includes persisting the outcome and releasing admission.
    if (!isExecutionActive(state))
      state.status = execution.abort.signal.aborted ? "stopping" : "running";
    return state;
  }

  assertReadable(id: string): void {
    if (!this.active.has(id)) this.ports.assertSession(id);
  }

  async submit(
    id: string,
    command: ConversationCommand,
  ): Promise<ConversationReceipt> {
    if (this.closed) throw new FlowError("会话服务正在关闭。", 503);
    const key = commandKey(id, command.commandId);
    const digest = commandDigest(command);
    const inFlight = this.pending.get(key);
    if (inFlight) await inFlight;
    const existing = this.record(key);
    if (existing) {
      if (existing.digest !== digest)
        throw new FlowError("命令 ID 已用于不同的内容。", 409);
      return this.receipt(id, command.commandId);
    }
    const admitted = this.admit(id, command, key, digest);
    this.pending.set(key, admitted);
    try {
      return await admitted;
    } finally {
      if (this.pending.get(key) === admitted) this.pending.delete(key);
    }
  }

  private async admit(
    id: string,
    command: ConversationCommand,
    key: string,
    digest: string,
  ): Promise<ConversationReceipt> {
    let execution: Execution | undefined;
    if (command.type === "turn.start") {
      if (this.active.has(id))
        throw new FlowError("这段对话还有一项执行在进行。", 409);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      execution = {
        state: {
          id: command.commandId,
          commandId: command.commandId,
          prompt: command.input.prompt,
          startedAt: Date.now(),
          status: "preparing",
        },
        abort: new AbortController(),
        done,
        finish,
      };
      this.active.set(id, execution);
    } else {
      execution = this.active.get(id);
      if (!execution) this.ports.assertSession(id);
      if (
        !execution ||
        execution.state.id !== command.executionId ||
        !isExecutionActive(execution.state)
      )
        throw new FlowError("目标执行已结束，请刷新会话状态。", 409);
    }
    const record: ConversationCommandRecord = {
      digest,
      epoch: this.epoch,
      receipt: {
        commandId: command.commandId,
        sessionId: id,
        executionId: execution.state.id,
        status: "accepted",
        ...(command.type === "turn.start"
          ? { execution: structuredClone(execution.state) }
          : {}),
      },
    };
    try {
      await this.table.put(key, structuredClone(record));
    } catch {
      if (command.type === "turn.start") {
        this.active.delete(id);
        execution.finish();
      }
      throw new FlowError("命令接收记录保存失败，尚未启动操作。", 503);
    }
    this.receipts.set(key, record);
    if (command.type === "turn.start") this.latest.set(id, key);
    this.events.publish(
      id,
      { type: "command", receipt: record.receipt },
      execution.state.id,
    );
    const accepted = structuredClone(record.receipt);
    const work = this.dispatch(id, command, key, record, execution);
    this.dispatches.add(work);
    void work.finally(() => this.dispatches.delete(work));
    return accepted;
  }

  private publishExecution(id: string, execution: Execution): void {
    this.events.publish(
      id,
      { type: "execution", execution: execution.state },
      execution.state.id,
      execution.turnId,
    );
  }

  private async save(
    key: string,
    record: ConversationCommandRecord,
  ): Promise<void> {
    await this.table.put(key, structuredClone(record));
    this.receipts.set(key, record);
  }

  private async dispatch(
    id: string,
    command: ConversationCommand,
    key: string,
    record: ConversationCommandRecord,
    execution: Execution,
  ): Promise<void> {
    let invoked = false;
    try {
      if (command.type === "turn.start") {
        execution.abort.signal.throwIfAborted();
        // Durable dispatch marker precedes every possible model/tool side effect.
        record.receipt.status = "applied";
        await this.save(key, record);
        execution.abort.signal.throwIfAborted();
        invoked = true;
        const result = await this.ports.start(
          id,
          command,
          (activity) => {
            if (activity.type === "turn-start") {
              execution.turnId = activity.turnId;
              this.events.bindTurn(id, execution.state.id, activity.turnId);
            }
            if (execution.state.status === "preparing")
              execution.state.status = "running";
            this.events.publish(
              id,
              { type: "activity", activity },
              execution.state.id,
              execution.turnId,
            );
          },
          execution.abort.signal,
        );
        execution.state = {
          ...execution.state,
          status: "complete",
          model: result.model,
          endedAt: Date.now(),
        };
      } else {
        if (
          this.active.get(id) !== execution ||
          !isExecutionActive(execution.state)
        )
          throw new FlowError("目标执行已结束，请刷新会话状态。", 409);
        invoked = true;
        if (command.type === "turn.stop") {
          execution.state.status = "stopping";
          this.publishExecution(id, execution);
          execution.abort.abort(new Error("用户停止了执行。"));
          await execution.done;
        } else {
          // The driver validates the exact question and running turn again.
          await this.ports.control(id, command);
        }
        record.receipt.status = "applied";
      }
    } catch (error) {
      const message =
        error instanceof FlowError && error.status < 500
          ? error.message
          : "会话操作未完成，请检查执行状态。";
      if (command.type === "turn.start") {
        execution.state = {
          ...execution.state,
          status: execution.abort.signal.aborted
            ? this.closed
              ? "interrupted"
              : "stopped"
            : "error",
          endedAt: Date.now(),
          ...(execution.abort.signal.aborted
            ? {}
            : {
                error: message,
                errorStatus: error instanceof FlowError ? error.status : 500,
              }),
        };
        if (!invoked) {
          record.receipt.status = "rejected";
          record.receipt.error = message;
        }
      } else {
        record.receipt.status =
          error instanceof FlowError && error.status < 500
            ? "rejected"
            : invoked
              ? "uncertain"
              : "rejected";
        record.receipt.error = message;
      }
    } finally {
      if (command.type === "turn.start")
        record.receipt.execution = structuredClone(execution.state);
      try {
        await this.save(key, record);
      } catch {
        record.receipt.status = "uncertain";
        record.receipt.error =
          "操作结果未能保存，请核对会话；系统不会自动重发。";
        this.receipts.set(key, record);
      }
      this.events.publish(
        id,
        { type: "command", receipt: record.receipt },
        execution.state.id,
      );
      if (command.type === "turn.start") {
        this.publishExecution(id, execution);
        if (this.active.get(id) === execution) this.active.delete(id);
        execution.finish();
      }
      // Durable receipts remain queryable without retaining all of them in RAM.
      if (this.receipts.size > 256) {
        for (const [storedKey, stored] of this.receipts) {
          if (this.receipts.size <= 128) break;
          if (
            !this.active.has(stored.receipt.sessionId) &&
            stored.receipt.status !== "uncertain"
          )
            this.receipts.delete(storedKey);
        }
      }
    }
  }

  /** History and the cursor are sampled only across an unchanged event revision. */
  async snapshot(id: string): Promise<ConversationSnapshot> {
    this.assertReadable(id);
    for (let attempt = 0; attempt < 20; attempt++) {
      const cursor = this.events.cursor(id);
      let history: CodingHistoryPage;
      try {
        history = await this.ports.history(id);
      } catch (error) {
        if (!(
          error instanceof FlowError &&
          error.status === 404 &&
          this.active.has(id)
        ))
          throw error;
        history = { turns: [], running: true, hasMore: false };
      }
      if (cursor !== this.events.cursor(id)) continue;
      for (const event of this.events.annotations(id)) {
        if (event.payload.type !== "activity") continue;
        const activity = event.payload.activity;
        const turn = event.turnId
          ? history.turns.find((item) => item.turnId === event.turnId)
          : undefined;
        if (!turn) continue;
        if (activity.type === "notice") {
          const at = turn.events.findIndex(
            (item) => item.type === "notice" && item.id === activity.id,
          );
          if (at < 0) turn.events.push(activity);
          else turn.events[at] = activity;
        } else if (
          activity.type === "workflow" &&
          !turn.events.some(
            (item) => item.type === "workflow" && item.runId === activity.runId,
          )
        )
          turn.events.push(activity);
      }
      const execution = this.execution(id);
      return {
        ...history,
        version: 1,
        sessionId: id,
        cursor,
        running: isExecutionActive(execution),
        ...(execution ? { execution } : {}),
      };
    }
    throw new FlowError("会话状态正在更新，请重新连接。", 503);
  }

  async stop(id: string): Promise<boolean> {
    const execution = this.active.get(id);
    if (!execution) return false;
    if (isExecutionActive(execution.state)) {
      execution.state.status = "stopping";
      this.publishExecution(id, execution);
      execution.abort.abort(new Error("用户停止了执行。"));
    }
    await execution.done;
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const execution of this.active.values())
      execution.abort.abort(new Error("会话服务已关闭。"));
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.dispatches]);
  }

  /** Compatibility adapter: abort detaches this observer, never the execution. */
  async stream(
    id: string,
    command: StartCommand,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    let cursor = this.events.cursor(id);
    await this.submit(id, command);
    while (true) {
      signal.throwIfAborted();
      const page = this.events.read(id, cursor);
      if (page.reset)
        throw new FlowError("事件窗口已过期，请重新读取会话。", 409);
      for (const event of page.events)
        if (
          event.executionId === command.commandId &&
          event.payload.type === "activity"
        )
          emit(event.payload.activity);
      cursor = page.cursor;
      const receipt = this.receipt(id, command.commandId);
      const execution = receipt.execution;
      if (execution && !isExecutionActive(execution)) {
        if (execution.status === "complete")
          return { model: execution.model ?? "" };
        throw new FlowError(
          execution.error ?? receipt.error ?? "执行已停止。",
          execution.errorStatus ?? 409,
        );
      }
      await delay(40, undefined, { signal });
    }
  }
}
