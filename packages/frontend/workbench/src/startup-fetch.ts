/** Retry only short-lived startup unavailability, never model execution. */
export async function startupFetch(url: string, signal?: AbortSignal) {
  const deadline = Date.now() + 5_000;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { signal });
      if (response.status !== 503 || Date.now() >= deadline) return response;
      await response.body?.cancel();
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TypeError) || Date.now() >= deadline) throw error;
    }
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(100 * 2 ** attempt, 500),
      );
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
