/** Checks actual DSH-backed HTTP streaming, not the device-only fallback. */
import assert from "node:assert/strict";
const base = process.env.AURA_RUNTIME_URL ?? "http://127.0.0.1:4311";
const health = await (await fetch(base + "/health")).json();
assert.ok(health.modes.includes("dsh-demo"));
const history = [{ role: "user", text: "你好，帮我梳理想法" }];
for (let turn = 0; turn < 2; turn++) {
  const response = await fetch(base + "/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "runtime-smoke", messages: history }),
    signal: AbortSignal.timeout(65000),
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "done", JSON.stringify(events));
  assert.equal(events.at(-1).engine, "deepseek-harness");
  const text = events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  assert.ok(text.length > 30);
  if (turn === 1) assert.match(text, /我们接着聊「你好，帮我梳理想法」/);
  console.log(
    `PASS DSH turn ${turn + 1}: ${events.length - 1} chunks, ${text.length} characters`,
  );
  history.push({ role: "assistant", text }, { role: "user", text: "继续" });
}
const invalid = await fetch(base + "/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "runtime-smoke", messages: [] }),
});
assert.equal(invalid.status, 400);
console.log("PASS invalid request rejected");
