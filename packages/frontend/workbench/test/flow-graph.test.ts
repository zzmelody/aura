import assert from "node:assert/strict";
import test from "node:test";
import { buildFlowGraph, layoutFlowGraph } from "../src/flowGraph.ts";

const wrap = (run: string) => `
  import { defineFlow, z } from "@aura/orchestration/flow";
  export default defineFlow({
    title: "解析测试",
    description: "只显示编排语义",
    concurrency: 3,
    input: z.object({ task: z.string(), count: z.number() }),
    output: z.object({ report: z.string() }),
    async run(ctx, input) {
      ${run}
    },
  });
`;

test("structured scopes project stable execution paths, parallel branches, memo and checkpoint", () => {
  const graph = buildFlowGraph(
    wrap(`return ctx.sequence({id:"main"}, async flow => {
    const values = await flow.parallel({id:"batch",branches:{
      a: branch => branch.agent({id:"call",label:"A",preset:"test",prompt:"a"}),
      b: branch => branch.action({id:"call",action:"write",input:{}})
    }});
    const approved = await flow.checkpoint({id:"approve",prompt:"?",schema:z.boolean()});
    return flow.memo({id:"result",schema:z.json(),compute:()=>values});
  });`),
  );
  assert.equal(graph.error, undefined);
  assert.deepEqual(
    graph.nodes
      .filter((node) =>
        ["agent", "tool", "memo", "checkpoint"].includes(node.kind),
      )
      .map((node) => node.id),
    ["main/batch/a/call", "main/batch/b/call", "main/approve", "main/result"],
  );
  assert.ok(
    graph.nodes.find((node) => node.id === "main/batch/a/call")?.parallel,
  );
  assert.equal(
    graph.edges.filter((edge) => edge.target === "main/approve").length,
    2,
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === "main/result" && edge.target === "$output",
    ),
  );
});

test("ignores ordinary JavaScript while preserving agent order", () => {
  const graph = buildFlowGraph(
    wrap(`
      const normalized = input.task.trim();
      console.log("starting", normalized);
      const prompt = formatPrompt(normalized);
      const result = await ctx.agent({
        id: "research",
        label: "调研",
        preset: "researcher-v1",
        prompt,
      });
      audit(result.output);
      return { report: result.output.toUpperCase() };
    `),
  );

  assert.equal(graph.error, undefined);
  assert.deepEqual(
    graph.nodes.map(({ kind }) => kind),
    ["input", "agent", "output"],
  );
  assert.deepEqual(
    graph.nodes.map(({ id }) => id),
    ["$input", "research", "$output"],
  );
  assert.deepEqual(
    graph.edges.map(({ source, target }) => [source, target]),
    [
      ["$input", "research"],
      ["research", "$output"],
    ],
  );
});

test("renders Promise.all as parallel agent nodes and if as an explicit branch", () => {
  const graph = buildFlowGraph(
    wrap(`
      const [research, review] = await Promise.all([
        ctx.agent({ id: "research", label: "调研", preset: "researcher-v1", prompt: input.task }),
        ctx.agent({ id: "review", label: "评审", preset: "reviewer-v1", prompt: input.task }),
      ]);
      const combined = research.output + review.output;
      if (input.count > 2) {
        await ctx.action({ id: "search", action: "web-search", input: { query: combined } });
      }
      return { report: combined };
    `),
  );

  const agents = graph.nodes.filter(({ kind }) => kind === "agent");
  assert.deepEqual(
    agents.map(({ id }) => id),
    ["research", "review"],
  );
  assert.ok(agents.every(({ parallel }) => parallel));
  assert.deepEqual(
    graph.nodes.map(({ kind }) => kind),
    ["input", "agent", "agent", "condition", "tool", "output"],
  );
  assert.ok(
    graph.edges.some(
      ({ source, target, label }) =>
        source.startsWith("condition-") &&
        target === "tool-web-search" &&
        label === "是",
    ),
  );
  assert.ok(
    graph.edges.some(
      ({ source, target, label }) =>
        source.startsWith("condition-") &&
        target === "$output" &&
        label === "否",
    ),
  );
});

test("renders loops and tool calls, with a back edge for the next iteration", () => {
  const graph = buildFlowGraph(
    wrap(`
      for (let index = 0; index < input.count; index++) {
        const page = await tools.fetch({ index });
        const compact = page.text.trim();
        remember(compact);
      }
      return { report: "done" };
    `),
  );

  assert.deepEqual(
    graph.nodes.map(({ kind }) => kind),
    ["input", "loop", "tool", "output"],
  );
  const loop = graph.nodes.find(({ kind }) => kind === "loop");
  const tool = graph.nodes.find(({ kind }) => kind === "tool");
  assert.ok(loop && tool);
  assert.ok(
    graph.edges.some(
      ({ source, target, label }) =>
        source === loop.id && target === tool.id && label === "迭代",
    ),
  );
  assert.ok(
    graph.edges.some(
      ({ source, target, label, back }) =>
        source === tool.id && target === loop.id && label === "继续" && back,
    ),
  );

  const layout = layoutFlowGraph(graph);
  const loopLayout = layout.nodes.find(({ id }) => id === loop.id);
  const toolLayout = layout.nodes.find(({ id }) => id === tool.id);
  assert.ok(loopLayout && toolLayout);
  assert.ok(toolLayout.level > loopLayout.level);
  assert.ok(
    layout.width < 2000,
    "loop back edges must not inflate graph levels",
  );
});

test("keeps a loop node even when its body only contains ignored logic", () => {
  const graph = buildFlowGraph(
    wrap(`
      let remaining = input.count;
      while (remaining > 0) {
        remaining -= 1;
        console.log(remaining);
      }
      return { report: "done" };
    `),
  );

  assert.deepEqual(
    graph.nodes.map(({ kind }) => kind),
    ["input", "loop", "output"],
  );
  const loop = graph.nodes.find(({ kind }) => kind === "loop");
  assert.ok(loop);
  assert.ok(
    graph.edges.some(
      ({ source, target, back }) =>
        source === loop.id && target === loop.id && back,
    ),
  );
});

test("treats Promise.all with map as a parallel dynamic loop", () => {
  const graph = buildFlowGraph(
    wrap(`
      const results = await Promise.all(
        input.task.split(",").map(async (item) => {
          const result = await ctx.agent({ id: item, label: "处理条目", preset: "researcher-v1", prompt: item });
          return result;
        })
      );
      return { report: results.map((result) => result.output).join("\\n") };
    `),
  );

  assert.deepEqual(
    graph.nodes.map(({ kind }) => kind),
    ["input", "loop", "agent", "loop", "output"],
  );
  const agent = graph.nodes.find(({ kind }) => kind === "agent");
  assert.ok(agent?.parallel);
  assert.equal(graph.nodes.filter(({ kind }) => kind === "agent").length, 1);
  assert.ok(
    !graph.edges.some(
      ({ source, target }) => source === agent.id && target === "$output",
    ),
  );
});

test("returns a readable graph error for incomplete code", () => {
  const graph = buildFlowGraph("export default defineFlow({ async run() {");
  assert.match(graph.error ?? "", /Unexpected token/);
  assert.deepEqual(graph.nodes, []);
});
