import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("Flow checkJs infers scoped branches, memo and checkpoint without exposing root operations", () => {
  const file = fileURLToPath(
    new URL("./virtual.flow.js", import.meta.url),
  ).replaceAll("\\", "/");
  const source = `
import { defineFlow, z } from "@aura/orchestration/flow";
defineFlow({
  title: "Types", input: z.object({ task: z.string() }),
  output: z.object({ report: z.string(), approved: z.boolean() }),
  async run(ctx, input) {
    // @ts-expect-error Root operations must enter a sequence first.
    ctx.agent({});
    // @ts-expect-error Parallel is only available inside a scope.
    ctx.parallel({});
    return ctx.sequence({ id: "main" }, async (flow) => {
      const results = await flow.parallel({
        id: "research", branches: {
          researcher: branch => branch.agent({
            id: "research", label: "Research", preset: "test", prompt: input.task,
            retry: { maxAttempts: 2 },
          }),
          score: branch => branch.memo({ id: "score", schema: z.number(), compute: () => 42 }),
        },
      });
      results.researcher.output.toUpperCase();
      results.score.toFixed(0);
      // @ts-expect-error Named branch results retain their exact keys.
      results.missing;
      // @ts-expect-error Memo output retains its schema's inferred type.
      results.score.toUpperCase();
      const answer = await flow.checkpoint({
        id: "approval", prompt: "Publish?", schema: z.object({ approved: z.boolean() }),
      });
      // @ts-expect-error Checkpoint output is inferred from its schema.
      answer.approved.toUpperCase();
      return flow.memo({
        id: "result", schema: z.object({ report: z.string(), approved: z.boolean() }),
        compute: () => ({ report: results.researcher.output, approved: answer.approved }),
      });
    });
  },
});
`;
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, error, create) =>
    name === file
      ? ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.ESNext,
          true,
          ts.ScriptKind.JS,
        )
      : read(name, language, error, create);
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([file], options, host),
  );
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
});
