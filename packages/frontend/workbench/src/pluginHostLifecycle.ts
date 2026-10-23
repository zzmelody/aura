interface DisposableHost {
  close(): Promise<void>;
}

/** Serializes StrictMode/endpoint changes, disposing the previous browser host. */
export class PluginHostLifecycle<T extends DisposableHost> {
  private active: T | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  start(create: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      await this.active?.close();
      this.active = undefined;
      const host = await create();
      this.active = host;
      return host;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
