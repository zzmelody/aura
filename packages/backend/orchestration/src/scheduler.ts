/** Single-process FIFO dispatcher. The durable Run table is the queue of record. */
export const DEFAULT_TOP_LEVEL_RUN_CONCURRENCY = 32;

export class FlowScheduler {
  readonly running = new Map<string, Promise<void>>();
  private closed = false;
  private pumping = false;
  private waiters = new Set<() => void>();
  private queued: () => string[];
  private execute: (id: string) => Promise<void>;
  private limit: number;
  constructor(
    queued: () => string[],
    execute: (id: string) => Promise<void>,
    limit = DEFAULT_TOP_LEVEL_RUN_CONCURRENCY,
  ) {
    this.queued = queued;
    this.execute = execute;
    this.limit = limit;
  }
  kick() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      for (const id of this.queued()) {
        if (this.running.size >= this.limit) break;
        if (this.running.has(id)) continue;
        const task = Promise.resolve().then(() => this.execute(id));
        this.running.set(id, task);
        void task
          .catch(() => undefined)
          .finally(() => {
            this.running.delete(id);
            this.notify();
            this.kick();
          });
      }
    } finally {
      this.pumping = false;
    }
  }
  changed() {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }
  notify() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  stop() {
    this.closed = true;
    this.notify();
  }
}
