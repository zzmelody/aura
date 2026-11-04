import assert from "node:assert/strict";
import test from "node:test";
import { pluginMarket } from "../src/plugin-market.ts";

test("market projects a validated synthetic index into searchable listings", async () => {
  const fetchIndex = async () =>
    Response.json({
      format: 1,
      title: "Synthetic market",
      plugins: [
        {
          name: "fixture-market",
          title: { en: "Fixture", zh: "示例插件" },
          description: "Synthetic plugin data",
          repository: { url: "https://example.com/repository" },
          metadata: { keywords: ["workspace"] },
          versions: [
            {
              version: "1.0.0",
              publishTimestamp: 1_000,
              source: { type: "npm" },
            },
          ],
        },
      ],
    });
  assert.deepEqual(await pluginMarket("workspace", fetchIndex), [
    {
      name: "fixture-market",
      title: "示例插件",
      description: "Synthetic plugin data",
      version: "1.0.0",
      sourceUrl: "https://example.com/repository",
    },
  ]);
  assert.deepEqual(await pluginMarket("unmatched", fetchIndex), []);
  await assert.rejects(
    pluginMarket("", async () =>
      Response.json({ format: 999, secret: "upstream-private-data" }),
    ),
    { status: 502, message: "暂时无法读取 DSH 插件市场。" },
  );
});
