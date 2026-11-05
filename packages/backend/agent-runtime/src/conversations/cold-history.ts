import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Storage from "@deepseek-ai/dsh-storage";
import * as JsonStorage from "@deepseek-ai/dsh-storage-json";
import { DomainFacility, type Domain } from "@deepseek-ai/dsh-storage-domain";
import { SessionId } from "@deepseek-ai/dsh-session";
import { legacyConversationTurns } from "@aura/protocol/conversations";
import type { CodingHistoryPage } from "@aura/protocol/types";
import { CodingConversationIndex, codingDomainSpec } from "./index-record.ts";
import { sessionHistoryTurns } from "./history.ts";
import {
  storedHistoryPage,
  type HistoryCursor,
} from "./stored-history-page.ts";
import { FlowError } from "@aura/protocol/errors";

/**
 * Read only settled coding logs before the execution host is ready. All format,
 * revision, torn-tail and schema validation stays in published DSH services.
 */
export async function coldCodingHistory(
  dshHome: string,
  sessionId: string,
  cursor: HistoryCursor,
  signal: AbortSignal,
): Promise<CodingHistoryPage | undefined> {
  signal.throwIfAborted();
  try {
    // A home-level overlay may redirect the persistence root or encoding.
    // Only the full profile loader can interpret arbitrary user overlays.
    if ((await lstat(join(dshHome, "cordis.patch.yml"))).size) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  signal.throwIfAborted();
  const temporary = await mkdtemp(join(tmpdir(), "aura-history-read-"));
  const context = new Context();
  let domain: Domain<typeof codingDomainSpec> | undefined;
  try {
    const source = join(dshHome, "aura-flow-storages");
    const snapshot = join(temporary, "index");
    await mkdir(snapshot);
    let bytes = 0;
    let files = 0;
    const copy = async (name: string) => {
      try {
        await cp(join(source, name), join(snapshot, name), {
          recursive: true,
          filter: async (path) => {
            signal.throwIfAborted();
            const stat = await lstat(path);
            if (stat.isSymbolicLink())
              throw new Error("Linked index is not a cold-read source");
            if (stat.isFile()) {
              bytes += stat.size;
              files++;
              if (bytes > 2 * 1_024 * 1_024 || files > 512)
                throw new Error("Index exceeds the cold-read snapshot budget");
            }
            return true;
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    // The JSON backend may bootstrap old index layouts when loading. It only
    // sees this private disposable copy, so reads never migrate user storage.
    await copy(codingDomainSpec.name);
    await copy(`${codingDomainSpec.name}.json`);
    if (!files) return undefined;
    signal.throwIfAborted();
    await context.plugin(Storage);
    await context.plugin(JsonStorage, { root: snapshot });
    const facility = new DomainFacility(context, { backend: "json" });
    domain = await facility.open(codingDomainSpec);
    const index = new CodingConversationIndex(domain.table("conversations"));
    const record = index.get(sessionId);
    const side = index.sideParent(sessionId);
    if (!record && !side) throw new FlowError("对话不存在或已移除。", 404);
    signal.throwIfAborted();
    await context.plugin(JsonlSessionPersistence, {
      root: join(dshHome, "aura-flow-sessions"),
      compression: "none",
    });
    const persistence = context.sessionPersistence;
    const id = SessionId(sessionId);
    const stored = await persistence.stat(id, { signal });
    if (!stored) {
      if (cursor.beforeSeq !== undefined) return undefined;
      return {
        turns: legacyConversationTurns(
          record?.history ?? [],
          record?.createdAt ?? 0,
        ),
        running: false,
        hasMore: false,
      };
    }
    const handle = await persistence.open(id, "read", { signal });
    try {
      const read = await handle.read(undefined, undefined, { signal });
      const page = storedHistoryPage(
        read.events,
        side || record?.sourceSessionId ? handle.inheritedEventCount : 0,
        cursor,
      );
      if (!page) return undefined;
      signal.throwIfAborted();
      return {
        hasMore: page.hasMore,
        beforeSeq: page.beforeSeq,
        throughSeq: page.throughSeq,
        turns: [
          ...legacyConversationTurns(
            !page.hasMore ? (record?.history ?? []) : [],
            record?.createdAt ?? 0,
          ),
          ...sessionHistoryTurns(page.events, false),
        ],
        running: false,
      };
    } finally {
      await handle.close();
    }
  } finally {
    try {
      await domain?.close();
    } finally {
      try {
        await context.fiber.dispose();
      } finally {
        await rm(temporary, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    }
  }
}
