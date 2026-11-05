import {
  isConversationCursor,
  isExecutionActive,
} from "@aura/protocol/conversation-channel";
import type {
  ConversationCommand,
  ConversationExecution,
  ConversationReceipt,
  ConversationSnapshot,
} from "@aura/protocol/conversation-channel";
import { parseConversationHistory } from "./api.ts";
import { WorkflowApiError } from "../../workflowSessions.ts";

export const CONVERSATION_UPDATE_REQUIRED =
  "运行中的后台尚未更新，请完全退出并重新打开 Aura。";

export interface ConversationView {
  snapshot?: ConversationSnapshot;
  connection:
    | "connecting"
    | "online"
    | "reconnecting"
    | "offline"
    | "waiting"
    | "unsupported";
  pending?: ConversationCommand;
  error?: string;
}
interface Entry {
  endpoint: string;
  id: string;
  view: ConversationView;
  listeners: Set<() => void>;
  abort?: AbortController;
  refresh?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  cursor?: string;
  generation: number;
  readerOnline: boolean;
}

function storageKey(endpoint: string, id: string) {
  return `aura.conversation.pending.v1:${JSON.stringify([endpoint, id])}`;
}
function savedCommand(
  endpoint: string,
  id: string,
): ConversationCommand | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const value = JSON.parse(
      globalThis.localStorage?.getItem(storageKey(endpoint, id)) ?? "null",
    ) as ConversationCommand | null;
    if (
      value &&
      typeof value.commandId === "string" &&
      ["turn.start", "turn.steer", "turn.stop", "question.answer"].includes(
        value.type,
      )
    )
      return value;
  } catch {
    /* Storage can be unavailable in a private browser. */
  }
  return undefined;
}
function persist(entry: Entry, command?: ConversationCommand) {
  try {
    if (typeof window === "undefined") return;
    const key = storageKey(entry.endpoint, entry.id);
    if (command) globalThis.localStorage?.setItem(key, JSON.stringify(command));
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* The in-memory receipt still prevents retries in this window. */
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function parseExecution(value: unknown): ConversationExecution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const execution = value as ConversationExecution;
  if (
    typeof execution.id !== "string" ||
    typeof execution.commandId !== "string" ||
    typeof execution.prompt !== "string" ||
    typeof execution.startedAt !== "number" ||
    ![
      "preparing",
      "running",
      "stopping",
      "complete",
      "stopped",
      "error",
      "interrupted",
    ].includes(execution.status)
  )
    return undefined;
  return execution;
}

export function parseConversationSnapshot(
  value: unknown,
  id: string,
): ConversationSnapshot {
  const source = value as Partial<ConversationSnapshot> | null;
  if (
    !source ||
    source.version !== 1 ||
    source.sessionId !== id ||
    !isConversationCursor(source.cursor)
  )
    throw new Error("无法读取会话快照。");
  return {
    ...parseConversationHistory(source),
    version: 1,
    sessionId: id,
    cursor: source.cursor,
    execution: parseExecution(source.execution),
  };
}

/** One reader per runtime/session. Unsubscribing never submits a stop command. */
export class ConversationStore {
  private readonly entries = new Map<string, Entry>();
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.fetcher = fetcher;
  }

  private entry(endpoint: string, id: string): Entry {
    endpoint = endpoint.replace(/\/$/u, "");
    const key = JSON.stringify([endpoint, id]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        endpoint,
        id,
        view: { connection: "connecting", pending: savedCommand(endpoint, id) },
        listeners: new Set(),
        generation: 0,
        readerOnline: false,
      };
      this.entries.set(key, entry);
      for (const [oldKey, old] of this.entries) {
        if (this.entries.size <= 64) break;
        if (
          old !== entry &&
          !old.listeners.size &&
          !old.abort &&
          !old.refresh &&
          !old.view.pending
        )
          this.entries.delete(oldKey);
      }
    }
    return entry;
  }

  view(endpoint: string, id: string): ConversationView {
    return this.entry(endpoint, id).view;
  }

  private publish(entry: Entry, patch: Partial<ConversationView>) {
    entry.view = { ...entry.view, ...patch };
    for (const listener of entry.listeners) listener();
  }

  subscribe(endpoint: string, id: string, listener: () => void): () => void {
    const entry = this.entry(endpoint, id);
    entry.listeners.add(listener);
    if (!entry.abort) this.startReader(entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        entry.abort?.abort();
        entry.abort = undefined;
        entry.readerOnline = false;
        entry.generation++;
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    };
  }

  private startReader(entry: Entry): void {
    const abort = new AbortController();
    entry.abort = abort;
    void this.connect(entry, abort.signal).finally(() => {
      if (entry.abort === abort) entry.abort = undefined;
    });
  }

  reconnect(endpoint: string, id: string): void {
    const entry = this.entry(endpoint, id);
    entry.abort?.abort();
    entry.readerOnline = false;
    entry.generation++;
    if (entry.listeners.size) this.startReader(entry);
  }

  private async checkChannel(
    entry: Entry,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetcher(`${entry.endpoint}/coding/channel`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (
      response.status === 404 ||
      (response.ok && (value as { version?: unknown } | null)?.version !== 1)
    ) {
      this.publish(entry, { connection: "unsupported" });
      throw new WorkflowApiError(CONVERSATION_UPDATE_REQUIRED, 426);
    }
    if (!response.ok) throw new Error("无法确认会话服务是否就绪。");
  }

  private url(entry: Entry, path: string) {
    return `${entry.endpoint}/coding/sessions/${encodeURIComponent(entry.id)}${path}`;
  }

  private async json(
    entry: Entry,
    path: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetcher(this.url(entry, path), {
      method: body === undefined ? "GET" : "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new WorkflowApiError(
        typeof (value as { message?: unknown })?.message === "string"
          ? (value as { message: string }).message
          : "会话请求未完成。",
        response.status,
      );
    return value;
  }

  private apply(entry: Entry, snapshot: ConversationSnapshot) {
    const previous = entry.view.snapshot;
    if (
      previous &&
      previous.cursor.split(":")[0] === snapshot.cursor.split(":")[0] &&
      Number(previous.cursor.split(":")[1]) >
        Number(snapshot.cursor.split(":")[1])
    )
      return;
    this.publish(entry, {
      snapshot,
      error: undefined,
      ...(entry.readerOnline ? { connection: "online" } : {}),
    });
  }

  async refresh(endpoint: string, id: string): Promise<void> {
    const entry = this.entry(endpoint, id);
    if (entry.refresh) return entry.refresh;
    const generation = entry.generation;
    let captured = false;
    const work = this.json(entry, "/snapshot", entry.abort?.signal).then(
      (value) => {
        if (generation === entry.generation) {
          this.apply(entry, parseConversationSnapshot(value, id));
          captured = true;
        }
      },
    );
    entry.refresh = work;
    try {
      await work;
    } finally {
      if (entry.refresh === work) entry.refresh = undefined;
      const current = entry.view.snapshot?.cursor;
      if (
        captured &&
        entry.listeners.size &&
        current &&
        entry.cursor &&
        current.split(":")[0] === entry.cursor.split(":")[0] &&
        Number(current.split(":")[1]) < Number(entry.cursor.split(":")[1])
      )
        this.invalidate(entry);
    }
  }

  private invalidate(entry: Entry, wait = 80) {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.refresh(entry.endpoint, entry.id).catch(() => {
        if (
          entry.listeners.size &&
          entry.abort &&
          !entry.abort.signal.aborted
        ) {
          this.publish(entry, { connection: "reconnecting" });
          this.invalidate(entry, 1000);
        }
      });
    }, wait);
  }

  private async connect(entry: Entry, signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted) {
      const connection = new AbortController();
      const readSignal = AbortSignal.any([signal, connection.signal]);
      let idle: ReturnType<typeof setTimeout> | undefined;
      try {
        this.publish(entry, {
          connection:
            entry.view.connection === "waiting"
              ? "waiting"
              : entry.view.snapshot
                ? "reconnecting"
                : "connecting",
        });
        if (entry.view.pending)
          await this.checkPending(entry, signal).catch(() => undefined);
        idle = setTimeout(() => connection.abort(), 30_000);
        const response = await this.fetcher(
          this.url(
            entry,
            `/events${entry.cursor ? `?cursor=${encodeURIComponent(entry.cursor)}` : ""}`,
          ),
          { signal: readSignal },
        );
        signal.throwIfAborted();
        if (response.status === 404) {
          await response.body?.cancel();
          await this.checkChannel(entry, readSignal);
          throw new WorkflowApiError("会话尚未保存。", 404);
        }
        if (!response.ok || !response.body)
          throw new Error("会话事件连接不可用。");
        if (
          !response.headers.get("Content-Type")?.startsWith("text/event-stream")
        )
          throw new Error("会话事件响应无效。");
        entry.readerOnline = true;
        this.publish(entry, { connection: "online" });
        this.invalidate(entry);
        attempts = 0;
        const reader = response.body.getReader();
        let buffer = "";
        const decoder = new TextDecoder();
        try {
          while (!signal.aborted) {
            clearTimeout(idle);
            idle = setTimeout(() => connection.abort(), 30_000);
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder
              .decode(chunk.value, { stream: true })
              .replace(/\r\n/gu, "\n");
            if (buffer.length > 16 * 1024 * 1024)
              throw new Error("会话事件过大。");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = frame.split("\n");
              const type = lines
                .find((line) => line.startsWith("event:"))
                ?.slice(6)
                .trim();
              const data = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              const cursor = lines
                .find((line) => line.startsWith("id:"))
                ?.slice(3)
                .trim();
              if (type === "unavailable")
                throw new Error("会话事件连接已中断。");
              if (type === "snapshot" || type === "reset") {
                entry.generation++;
                this.apply(
                  entry,
                  parseConversationSnapshot(JSON.parse(data), entry.id),
                );
              } else if (type === "event") {
                const event = JSON.parse(data) as {
                  version?: unknown;
                  sessionId?: unknown;
                  cursor?: unknown;
                };
                if (
                  event.version !== 1 ||
                  event.sessionId !== entry.id ||
                  event.cursor !== cursor ||
                  !isConversationCursor(cursor)
                )
                  throw new Error("无效的会话事件。");
                this.invalidate(entry);
              }
              if (isConversationCursor(cursor)) entry.cursor = cursor;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } catch (error) {
        if (error instanceof WorkflowApiError && error.status === 426) return;
        if (!signal.aborted)
          this.publish(entry, {
            connection:
              error instanceof WorkflowApiError && error.status === 404
                ? "waiting"
                : "reconnecting",
          });
      } finally {
        clearTimeout(idle);
        connection.abort();
        if (entry.abort?.signal === signal) entry.readerOnline = false;
      }
      if (!signal.aborted) {
        if (entry.view.connection !== "waiting")
          this.publish(entry, { connection: "reconnecting" });
        await pause(Math.min(500 * 2 ** attempts++, 5_000), signal).catch(
          () => undefined,
        );
      }
    }
  }

  private parseReceipt(
    value: unknown,
    id: string,
    commandId: string,
  ): ConversationReceipt {
    const receipt = value as ConversationReceipt;
    if (
      !receipt ||
      receipt.sessionId !== id ||
      receipt.commandId !== commandId ||
      typeof receipt.executionId !== "string" ||
      !["accepted", "applied", "rejected", "uncertain"].includes(receipt.status)
    )
      throw new Error("无法确认命令接收状态。");
    return { ...receipt, execution: parseExecution(receipt.execution) };
  }

  private async checkPending(entry: Entry, signal?: AbortSignal) {
    const pending = entry.view.pending;
    if (!pending) return;
    const receipt = this.parseReceipt(
      await this.json(
        entry,
        `/commands/${encodeURIComponent(pending.commandId)}`,
        signal,
      ),
      entry.id,
      pending.commandId,
    );
    if (entry.view.pending?.commandId === pending.commandId) {
      persist(entry);
      this.publish(entry, { pending: undefined, error: receipt.error });
    }
    return receipt;
  }

  async submit(
    endpoint: string,
    id: string,
    command: ConversationCommand,
  ): Promise<ConversationReceipt> {
    const entry = this.entry(endpoint, id);
    if (entry.view.connection === "unsupported")
      throw new WorkflowApiError(CONVERSATION_UPDATE_REQUIRED, 426);
    if (
      entry.view.pending &&
      entry.view.pending.commandId !== command.commandId
    )
      throw new Error("上一条命令尚未确认，请先查询或重试原命令。");
    persist(entry, command);
    this.publish(entry, { pending: command });
    let receipt: ConversationReceipt;
    try {
      receipt = this.parseReceipt(
        await this.json(entry, "/commands", undefined, command),
        id,
        command.commandId,
      );
    } catch (error) {
      if (
        error instanceof WorkflowApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        persist(entry);
        this.publish(entry, { pending: undefined });
        if (error.status === 404) {
          try {
            await this.checkChannel(entry);
          } catch (versionError) {
            if (
              versionError instanceof WorkflowApiError &&
              versionError.status === 426
            )
              throw versionError;
            // The command's definite rejection remains valid if the probe fails.
          }
        }
        throw error;
      }
      const found = await this.checkPending(entry).catch(() => undefined);
      if (found) return found;
      this.publish(entry, {
        error: "命令是否送达尚未确认，可查询状态或重试原命令。",
      });
      throw new Error("命令是否送达尚未确认，原命令已保留。", { cause: error });
    }
    persist(entry);
    this.publish(entry, { pending: undefined, error: receipt.error });
    this.invalidate(entry);
    return receipt;
  }

  async retryPending(endpoint: string, id: string): Promise<void> {
    const entry = this.entry(endpoint, id);
    const found = await this.checkPending(entry).catch(() => undefined);
    if (!found && entry.view.pending)
      await this.submit(endpoint, id, entry.view.pending);
    await this.refresh(endpoint, id);
  }

  async wait(
    endpoint: string,
    id: string,
    commandId: string,
    signal: AbortSignal,
  ): Promise<ConversationReceipt> {
    const entry = this.entry(endpoint, id);
    while (!signal.aborted) {
      let receipt: ConversationReceipt | undefined;
      try {
        receipt = this.parseReceipt(
          await this.json(
            entry,
            `/commands/${encodeURIComponent(commandId)}`,
            signal,
          ),
          id,
          commandId,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof WorkflowApiError &&
          error.status >= 400 &&
          error.status < 500
        )
          throw error;
      }
      if (
        receipt &&
        receipt.status !== "accepted" &&
        !isExecutionActive(receipt.execution)
      ) {
        await this.refresh(endpoint, id).catch(() => {
          if (receipt?.execution) {
            const prior = entry.view.snapshot;
            this.publish(entry, {
              snapshot: {
                version: 1,
                sessionId: id,
                cursor: prior?.cursor ?? `${crypto.randomUUID()}:0`,
                turns: prior?.turns ?? [],
                hasMore: prior?.hasMore ?? false,
                running: false,
                execution: receipt.execution,
              },
            });
          }
        });
        return receipt;
      }
      await pause(350, signal);
    }
    signal.throwIfAborted();
    throw new Error("会话观察已结束。");
  }

  close(): void {
    for (const entry of this.entries.values()) {
      entry.listeners.clear();
      entry.abort?.abort();
      entry.abort = undefined;
      entry.readerOnline = false;
      clearTimeout(entry.timer);
      entry.generation++;
    }
    this.entries.clear();
  }
}

export const conversations = new ConversationStore();
