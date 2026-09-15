import assert from "node:assert/strict";
import test from "node:test";
import { extractFlowCode, flowContext, starterFlow } from "../src/flowDraft.ts";
import { validateMessages } from "@aura/protocol";

test("only complete Flow code can be applied; prose, unrelated and streaming blocks are ignored", () => {
  assert.equal(extractFlowCode("use defineFlow to create a Flow"), undefined);
  assert.equal(extractFlowCode("```js\nconsole.log('hello');\n```"), undefined);
  assert.equal(extractFlowCode("```javascript\n" + starterFlow), undefined);
  assert.equal(
    extractFlowCode("```javascript\n" + starterFlow + "```"),
    starterFlow.trim(),
  );
});

test("uses the final complete Flow revision, preserving multiline code", () => {
  const revised = starterFlow.replace("我的第一个 Flow", "修订后的 Flow");
  assert.equal(
    extractFlowCode(
      "```js\n" +
        starterFlow +
        "```\n修订如下：\n```typescript\n" +
        revised +
        "```",
    ),
    revised.trim(),
  );
  assert.equal(extractFlowCode("```js\r\n" + revised + "```"), revised.trim());
});

test("Flow context stays inside protocol history limits without truncating the user request", () => {
  const context = flowContext("x".repeat(20_000));
  assert.match(context, /前 9000 字符/);
  assert.ok(context.length <= 12000);
  assert.ok(
    validateMessages([
      { role: "user", text: context },
      { role: "user", text: "生".repeat(4000) },
    ]),
  );
  assert.match(flowContext(starterFlow), /researcher-v1/);
  assert.match(flowContext(starterFlow), /reasoningEffort/);
  assert.match(flowContext(starterFlow), /Codex 适配器不支持/);
  assert.match(starterFlow, /agentDefaults/);
  assert.match(starterFlow, /reasoningEffort: ctx.mode/);
  assert.ok(flowContext(starterFlow).includes(starterFlow));
});
