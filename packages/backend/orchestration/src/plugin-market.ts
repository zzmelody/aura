import { FlowError } from "./schema.ts";
import type { MarketListing } from "@aura/protocol/types";

const source = "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";
// Format 1 permits inline icons for each entry in the public index.
const maxBytes = 16 * 1024 * 1024;

export async function pluginMarket(
  query: string,
  fetchIndex = fetch,
): Promise<MarketListing[]> {
  try {
    const [{ parseMarketIndex }, response] = await Promise.all([
      import("@deepseek-ai/dsh-plugin-market-index"),
      fetchIndex(source, {
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
      }),
    ]);
    if (!response.ok || !response.body) throw new Error("Catalog unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maxBytes) throw new Error("Catalog too large");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const catalog = parseMarketIndex(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      source,
    );
    const localized = (text: string | Record<string, string> | undefined) =>
      typeof text === "string"
        ? text
        : (text?.["zh-CN"] ?? text?.zh ?? text?.en ?? "");
    const needle = query.toLowerCase();
    return catalog.plugins
      .flatMap((entry): MarketListing[] => {
        const title = localized(entry.title) || entry.name;
        const description = localized(entry.description);
        if (
          !`${entry.name} ${title} ${description} ${entry.metadata.keywords.join(" ")}`
            .toLowerCase()
            .includes(needle)
        )
          return [];
        return [
          {
            name: entry.name,
            title,
            description,
            version: entry.versions[0].version,
            sourceUrl: entry.repository?.url ?? entry.homepage,
          },
        ];
      })
      .slice(0, 80);
  } catch {
    throw new FlowError("暂时无法读取 DSH 插件市场。", 502);
  }
}
