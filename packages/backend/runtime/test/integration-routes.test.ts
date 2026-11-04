import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "@aura/orchestration";
import { createIntegrationApp } from "../src/integration-routes.ts";

test("integration settings and voice preparation require a loopback runtime", async () => {
  const calls: string[] = [];
  const app = createIntegrationApp(
    {
      async request<T>(method: string) {
        calls.push(method);
        return { voice: false } as T;
      },
      async transcribeVoice() {
        return { text: "" };
      },
    },
    false,
  );
  assert.equal((await app.request("/settings")).status, 403);
  assert.equal(
    (await app.request("/settings", { method: "POST" })).status,
    403,
  );
  assert.equal(
    (await app.request("/voice/prepare", { method: "POST" })).status,
    403,
  );
  assert.deepEqual(await (await app.request("/flags")).json(), {
    voice: false,
  });
  assert.deepEqual(calls, ["integrations/flags"]);
});

test("voice route bounds uploads and projects the transcription result", async () => {
  const calls: string[] = [];
  const app = createIntegrationApp(
    {
      async request() {
        throw new FlowError("语音输入未启用。", 409);
      },
      async transcribeVoice(_id, audio, signal) {
        assert.equal(signal.aborted, false);
        calls.push(audio);
        return { text: "合成转写" };
      },
    },
    true,
  );
  const submit = (body: BodyInit, type: string) =>
    app.request("/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": type },
      body,
    });
  assert.equal((await submit("synthetic", "text/plain")).status, 415);
  assert.equal(
    (await submit(new Uint8Array(960_045), "audio/wav")).status,
    413,
  );
  const response = await submit("synthetic", "audio/wav; codecs=pcm");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "合成转写" });
  assert.deepEqual(calls, [Buffer.from("synthetic").toString("base64")]);
  assert.equal(
    (await app.request("/voice/cancel", { method: "POST" })).status,
    409,
  );
});
