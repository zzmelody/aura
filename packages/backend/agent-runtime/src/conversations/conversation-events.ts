import { randomUUID } from "node:crypto";
import type {
  ConversationEvent,
  ConversationEventPage,
} from "@aura/protocol/conversation-channel";

interface Channel {
  epoch: string;
  sequence: number;
  bytes: number;
  events: Array<{ value: ConversationEvent; bytes: number }>;
  annotations: Map<string, { value: ConversationEvent; bytes: number }>;
  annotationBytes: number;
}

/** A bounded, disposable replay window. Eviction changes the epoch, not history. */
export class ConversationEvents {
  private readonly channels = new Map<string, Channel>();
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  constructor(maxBytes = 256 * 1024, maxEvents = 256) {
    this.maxBytes = maxBytes;
    this.maxEvents = maxEvents;
  }

  private channel(id: string): Channel {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = {
        epoch: randomUUID(),
        sequence: 0,
        bytes: 0,
        events: [],
        annotations: new Map(),
        annotationBytes: 0,
      };
      this.channels.set(id, channel);
      if (this.channels.size > 64)
        this.channels.delete(this.channels.keys().next().value!);
    }
    return channel;
  }

  cursor(id: string): string {
    const channel = this.channel(id);
    return `${channel.epoch}:${channel.sequence}`;
  }

  publish(
    id: string,
    payload: ConversationEvent["payload"],
    executionId?: string,
    turnId?: string,
  ): void {
    const channel = this.channel(id);
    const value: ConversationEvent = structuredClone({
      version: 1,
      sessionId: id,
      cursor: `${channel.epoch}:${++channel.sequence}`,
      ...(executionId ? { executionId } : {}),
      ...(turnId ? { turnId } : {}),
      payload,
    });
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (
      payload.type === "activity" &&
      (payload.activity.type === "notice" ||
        payload.activity.type === "workflow")
    ) {
      const key =
        payload.activity.type === "notice"
          ? `notice:${payload.activity.id}`
          : `workflow:${payload.activity.runId}`;
      channel.annotationBytes -= channel.annotations.get(key)?.bytes ?? 0;
      channel.annotations.delete(key);
      channel.annotations.set(key, { value, bytes });
      channel.annotationBytes += bytes;
      this.trimAnnotations(channel);
    }
    channel.events.push({ value, bytes });
    channel.bytes += bytes;
    while (
      channel.events.length > this.maxEvents ||
      channel.bytes > this.maxBytes
    ) {
      channel.bytes -= channel.events.shift()!.bytes;
    }
  }

  /** Runtime notices and early workflow cards may precede their durable tool result. */
  annotations(id: string): ConversationEvent[] {
    return [...this.channel(id).annotations.values()].map(({ value }) =>
      structuredClone(value),
    );
  }

  /** Attach preparation notices once the execution gets its first native turn. */
  bindTurn(id: string, executionId: string, turnId: string): void {
    const channel = this.channel(id);
    for (const entry of channel.annotations.values())
      if (entry.value.executionId === executionId && !entry.value.turnId) {
        entry.value = { ...entry.value, turnId };
        const bytes = Buffer.byteLength(JSON.stringify(entry.value));
        channel.annotationBytes += bytes - entry.bytes;
        entry.bytes = bytes;
      }
    this.trimAnnotations(channel);
  }

  private trimAnnotations(channel: Channel): void {
    while (
      channel.annotations.size > 64 ||
      channel.annotationBytes > this.maxBytes
    ) {
      const oldest = channel.annotations.keys().next().value!;
      channel.annotationBytes -= channel.annotations.get(oldest)!.bytes;
      channel.annotations.delete(oldest);
    }
  }

  read(id: string, cursor?: string): ConversationEventPage {
    const channel = this.channel(id);
    const [epoch, raw] = cursor?.split(":") ?? [];
    const sequence = Number(raw);
    const first = channel.sequence - channel.events.length;
    const reset =
      epoch !== channel.epoch ||
      !Number.isSafeInteger(sequence) ||
      sequence < first ||
      sequence > channel.sequence;
    return {
      cursor: this.cursor(id),
      reset,
      events: reset
        ? []
        : channel.events
            .slice(sequence - first)
            .map(({ value }) => structuredClone(value)),
    };
  }
}
