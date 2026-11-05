import type { ConversationSearchHit } from "@aura/protocol/types";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  SessionQueryError,
  type SessionQueryEngine,
} from "@deepseek-ai/dsh-session-query";

const messageTypes = ["user/message", "assistant/message"] as const;
const limit = 30;

export async function searchCodingSessions(
  service: SessionQueryEngine,
  titles: ReadonlyMap<string, string>,
  query: string,
  signal: AbortSignal,
): Promise<ConversationSearchHit[]> {
  const ids = [...titles.keys()].map(SessionId);
  if (!ids.length) return [];
  const { items } = await service.searchSessions(
    {
      query,
      limit,
      sessionFilters: [{ kind: "id", values: ids }],
      eventFilters: [{ kind: "type", values: messageTypes }],
    },
    { signal },
  );
  if (items.length || !/\p{Script=Han}/u.test(query))
    return items.map(({ header, bestMatch }) => ({
      id: header.id,
      title: titles.get(header.id) ?? "会话",
      snippet: bestMatch.snippet,
    }));

  // FTS tokenizes contiguous Han text as words. Use the native literal
  // event filter when a phrase inside one of those words has no ranked hit.
  const hits: ConversationSearchHit[] = [];
  const normalized = query.toLowerCase();
  for (let start = 0; start < ids.length && hits.length < limit; start += 4) {
    signal.throwIfAborted();
    const batch = await Promise.all(
      ids.slice(start, start + 4).map(async (id) => {
        const matches = await service
          .filterEvents(id, [
            { kind: "type", values: messageTypes },
            { kind: "text", text: query },
          ])
          .catch((error: unknown) => {
            if (
              error instanceof SessionQueryError &&
              error.code === "SESSION_QUERY_SESSION_NOT_FOUND"
            )
              return [];
            throw error;
          });
        const match = matches.at(-1);
        if (!match) return [];
        const text = match.text.replace(/\s+/gu, " ");
        const offset = Math.max(0, text.toLowerCase().indexOf(normalized) - 45);
        return [
          {
            id,
            title: titles.get(id) ?? "会话",
            snippet: text.slice(offset, offset + 240),
          },
        ];
      }),
    );
    hits.push(...batch.flat());
  }
  signal.throwIfAborted();
  return hits.slice(0, limit);
}
