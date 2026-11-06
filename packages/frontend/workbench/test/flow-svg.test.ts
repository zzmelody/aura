import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFlowSvg,
  flowAnalysisInstructions,
} from "../src/flow-analysis.ts";

const svg = (id: string, title = "流程") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" data-analysis-id="${id}"><title>${title}</title></svg>`;

test("only complete SVG artifacts for the current source can update a diagram", () => {
  assert.equal(
    extractFlowSvg("```svg\n" + svg("current"), "current"),
    undefined,
  );
  assert.equal(
    extractFlowSvg("```svg\n" + svg("previous") + "```", "current"),
    undefined,
  );
  assert.equal(
    extractFlowSvg("```html\n" + svg("current") + "```", "current"),
    undefined,
  );
  assert.equal(
    extractFlowSvg('```svg\n<svg data-analysis-id="current">```', "current"),
    undefined,
  );
  assert.equal(
    extractFlowSvg("```svg\r\n" + svg("current") + "```", "current"),
    svg("current"),
  );
});

test("the final complete SVG revision wins without changing its contents", () => {
  const reply = `说明\n\`\`\`svg\n${svg("current", "初稿")}\n\`\`\`\n\`\`\`svg\n${svg("current", "定稿")}\n\`\`\``;
  assert.equal(extractFlowSvg(reply, "current"), svg("current", "定稿"));
  const instructions = flowAnalysisInstructions("source-revision");
  assert.ok(instructions.includes('data-analysis-id="source-revision"'));
  assert.ok(instructions.includes("SVG"));
  assert.ok(instructions.includes("var(--text)"));
});
