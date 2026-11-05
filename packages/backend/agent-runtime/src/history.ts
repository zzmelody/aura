import { FlowError } from "@aura/protocol/errors";
import type { CodingHistoryPage } from "@aura/protocol/types";

type HistoryOptions = {
  page?: boolean;
  beforeSeq?: number;
  throughSeq?: number;
};
type HistoryPage = Omit<CodingHistoryPage, "hasMore"> & { hasMore?: boolean };

interface HistoryHost {
  dshHome: string;
  closed(): boolean;
  ready(): boolean;
  open(): Promise<unknown>;
  read(
    sessionId: string,
    options: HistoryOptions,
    signal: AbortSignal,
  ): Promise<HistoryPage>;
}

/** Use the stored log before DSH is ready and the live reader after startup. */
export async function readCodingHistory(
  host: HistoryHost,
  sessionId: string,
  options: HistoryOptions,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  if (host.closed()) throw new FlowError("编排服务正在关闭。", 503);
  const readSignal = signal ?? AbortSignal.timeout(30_000);
  readSignal.throwIfAborted();
  if (!host.ready() && options.page) {
    try {
      const { coldCodingHistory } =
        await import("./conversations/cold-history.ts");
      const page = await coldCodingHistory(
        host.dshHome,
        sessionId,
        options,
        readSignal,
      );
      readSignal.throwIfAborted();
      if (page && !host.ready() && !host.closed()) return page;
    } catch (error) {
      readSignal.throwIfAborted();
      if (
        !host.ready() &&
        error instanceof FlowError &&
        [400, 404].includes(error.status)
      )
        throw error;
      // Unsupported or unavailable snapshots use the existing live reader.
    }
  }
  readSignal.throwIfAborted();
  if (!host.ready()) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(readSignal.reason);
      readSignal.addEventListener("abort", abort, { once: true });
      void host
        .open()
        .then(() => resolve(), reject)
        .finally(() => {
          readSignal.removeEventListener("abort", abort);
        });
    });
  }
  readSignal.throwIfAborted();
  return host.read(sessionId, options, readSignal);
}
