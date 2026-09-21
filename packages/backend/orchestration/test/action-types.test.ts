import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("Action .d.ts provides checkJs input/output inference and a leaf execution context", () => {
  const file = fileURLToPath(
    new URL("./virtual.action.js", import.meta.url),
  ).replaceAll("\\", "/");
  const source = `
import { ActionFailure, defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";
defineAction({
  title: "Types", description: "Type fixture",
  parameters: { text: { type: "string", required: true } },
  output: { schema: { type: "string" }, render: (_, output) => [{ type: "text", text: output.toUpperCase() }] },
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    ctx.cwd.toUpperCase();
    ctx.idempotencyKey?.toUpperCase();
    localAI(ctx).image({ prompt: input.text }, ctx.signal);
    localAI(ctx).comfyWorkflow({ service: "qwen-image", workflowFile: "test.json", overrides: { "6": { text: input.text } } }, ctx.signal);
    // @ts-expect-error ComfyUI workflows cannot target the standalone TTS service.
    localAI(ctx).comfyWorkflow({ service: "qwen3-tts", workflow: {} }, ctx.signal);
    // @ts-expect-error Media Actions require a string prompt.
    localAI(ctx).image({ prompt: 42 }, ctx.signal);
    // @ts-expect-error Actions have no Flow invocation API.
    ctx.flow("nested");
    // @ts-expect-error Input is inferred from DSH parameters.
    input.missing;
    if (!input.text) throw new ActionFailure("Text is required.");
    return input.text.toUpperCase();
  },
});
defineAction({
  title: "Wrong output", description: "Type fixture", parameters: {},
  output: { schema: { type: "string" }, render: (_, output) => [{ type: "text", text: output }] },
  // @ts-expect-error execute must return the declared output type.
  async execute() { return 123; },
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
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
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
