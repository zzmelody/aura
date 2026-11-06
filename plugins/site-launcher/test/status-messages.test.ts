import assert from "node:assert/strict";
import test from "node:test";
import { readSiteMessage, SiteStatusError } from "../shared/status-messages.ts";
import { SiteRunner } from "../backend/site-runner.ts";
import { siteErrorMessages } from "../backend/error-messages.ts";

test("page errors reuse six offline status translations without accepting unknown diagnostics", () => {
  const error = new SiteStatusError("old original message", {
    code: "previewNotReady",
  });
  const translations = siteErrorMessages(error)!;
  assert.equal(Object.keys(translations).length, 6);
  assert.equal(new Set(Object.values(translations)).size, 6);
  assert.equal(error.message, "old original message");
  assert.equal(siteErrorMessages(new Error("previewNotReady")), undefined);
  const port = siteErrorMessages(
    new SiteStatusError("old port message", {
      code: "portOccupied",
      params: { port: 3000 },
    }),
  )!;
  assert.ok(port.en.includes("3000"));
});

test("site status descriptors keep literal script and local URL values while discarding arbitrary diagnostics", () => {
  for (const value of [
    { code: "checkingPorts" },
    { code: "runningScript", params: { manager: "pnpm", script: "dev:local" } },
    { code: "portChanged", params: { preferred: 3000, port: 3001 } },
    {
      code: "addressChanged",
      params: {
        previous: "http://localhost:3000/",
        url: "http://127.0.0.1:3001/base?q=1",
      },
    },
    { code: "processExitCode", params: { exitCode: 7 } },
    { code: "processExitSignal", params: { signal: "SIGTERM" } },
  ])
    assert.deepEqual(
      readSiteMessage({ ...value, private: "must-not-render" }),
      value,
    );
  assert.deepEqual(
    readSiteMessage({
      code: "portOccupied",
      params: { port: 3000, private: "must-not-render" },
    }),
    { code: "portOccupied", params: { port: 3000 } },
  );
  for (const value of [
    { code: "future" },
    { code: "portOccupied", params: { port: 0 } },
    { code: "noFreePort", params: { port: 65536 } },
    { code: "processExitCode", params: { exitCode: Infinity } },
    { code: "runningScript", params: { manager: "sh", script: "private" } },
    {
      code: "runningScript",
      params: { manager: "npm", script: "dev; command" },
    },
    { code: "processExitSignal", params: { signal: "private diagnostic" } },
    {
      code: "addressChanged",
      params: {
        previous: "http://localhost:3000/",
        url: "https://remote.invalid/private",
      },
    },
    {
      code: "addressChanged",
      params: {
        previous: "http://localhost:3000/",
        url: "http://user:pass@localhost:3001/",
      },
    },
  ])
    assert.equal(readSiteMessage(value), undefined);
  const error = new SiteStatusError("Legacy message", {
    code: "scriptMissing",
  });
  assert.equal(error.message, "Legacy message");
  assert.deepEqual(error.details, { code: "scriptMissing" });
});

test("invalid project input publishes a translatable failure without starting a process", async (t) => {
  const runner = new SiteRunner({
    onStatus() {},
    async openPreview() {
      assert.fail("Invalid input must not open a preview");
    },
  });
  t.after(() => runner.stop().then(() => undefined));
  const missing = await runner.start(null);
  assert.equal(missing.state, "error");
  assert.equal(missing.pid, undefined);
  assert.equal(missing.message, "未选择项目目录。");
  assert.deepEqual(missing.messageDetails, { code: "directoryRequired" });
  const relative = await runner.start({ directory: "relative" });
  assert.deepEqual(relative.messageDetails, { code: "directoryAbsolute" });
  assert.equal(relative.pid, undefined);
});
