import assert from "node:assert/strict";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  DeepSeekSearchApiProvider,
  DeepSeekFetchApiProvider,
} from "@deepseek-ai/dsh-web-deepseek-api";

/** Synthetic API fixture: validates the published adapter contract without paid access. */
test("native DeepSeek APIs omit the original question, preserve sources and do not retry failed requests", async (t) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const app = new Hono();
  app.post("/tools/:operation", async (context) => {
    const body = (await context.req.json()) as Record<string, unknown>;
    requests.push({ path: context.req.path, body });
    if (body.query === "failure")
      return context.json({ error: "synthetic failure" }, 503);
    if (context.req.param("operation") === "fetch")
      return context.json({
        url: "https://example.com/",
        content: "Synthetic page",
        status_code: 200,
      });
    return context.json({
      results: [
        {
          url: "https://example.com/",
          title: "Synthetic source",
          snippet: "Synthetic snippet",
          date: null,
        },
      ],
    });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const options = {
    baseURL: `http://127.0.0.1:${address.port}/tools`,
    resolveApiKey: async () => "synthetic-test-key",
    count: 10,
  };
  const search = new DeepSeekSearchApiProvider(() => options);
  assert.equal(search.id, "deepseek-search-api");
  const result = await search.search({ query: "synthetic", maxResults: 2 });
  assert.equal(result.sources[0]?.url, "https://example.com/");
  assert.equal(requests[0]?.body.count, 2);
  assert.equal(requests[0]?.body.ori_question, undefined);
  await assert.rejects(search.search({ query: "failure" }));
  assert.equal(
    requests.filter((request) => request.body.query === "failure").length,
    1,
  );
  const fetcher = new DeepSeekFetchApiProvider(() => options);
  assert.equal(fetcher.id, "deepseek-fetch-api");
  assert.equal(
    (await fetcher.fetch({ url: "https://example.com/" })).body.content,
    "Synthetic page",
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    fetcher.fetch({ url: "https://example.com/" }, abort.signal),
  );
  assert.equal(requests.length, 3);
});
