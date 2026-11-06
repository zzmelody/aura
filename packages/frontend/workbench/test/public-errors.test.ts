import assert from "node:assert/strict";
import test from "node:test";
import { MessageError, errorMessage, messageText } from "@aura/plugin-ui";
import { language, locales } from "@aura/i18n/runtime";
import {
  uploadWorkflowImage,
  workflowApi,
  WorkflowApiError,
} from "../src/workflowSessions.ts";
import { invokePluginPage } from "../src/pluginPages.ts";
import { chooseWorkflowPath } from "../src/file-picker.ts";
import { openExternal } from "../src/platform.ts";

test("public transports retain translatable failures, legacy messages, statuses and original requests", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocale = language.getSnapshot().locale;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await language.systemChanged([originalLocale]);
  });
  await language.systemChanged(["en"]);
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  let response = () => new Response("unavailable", { status: 503 });
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), options });
    return response();
  };
  const signal = new AbortController().signal;
  const body = {
    requestId: "same-original-id",
    input: { name: "用户输入" },
    mode: "direct",
  };
  const errors: MessageError[] = [];
  async function capture(work: Promise<unknown>, key: string, status?: number) {
    await assert.rejects(work, (error: unknown) => {
      assert.ok(
        error instanceof MessageError,
        "SDK uses the same error identity as host transports",
      );
      assert.notEqual(typeof error.text, "string");
      assert.equal(typeof error.text === "object" && error.text.key, key);
      assert.equal(error.message, messageText(error.text));
      if (status !== undefined) {
        assert.ok(error instanceof WorkflowApiError);
        assert.equal(error.status, status);
        assert.equal(error.name, "Error");
      }
      errors.push(error);
      return true;
    });
  }
  await capture(
    workflowApi("https://synthetic.invalid/", "/flow/runs", body, signal),
    "serviceHttpUnavailable",
    503,
  );
  assert.equal(requests[0].url, "https://synthetic.invalid/flows/flow/runs");
  assert.equal(requests[0].options?.signal, signal);
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)), body);
  await capture(
    invokePluginPage(
      "https://synthetic.invalid",
      "example.plugin",
      "start",
      body,
      signal,
    ),
    "invokeFailed",
  );
  assert.equal(
    requests[1].url,
    "https://synthetic.invalid/plugins/pages/example.plugin/invoke",
  );
  assert.deepEqual(JSON.parse(String(requests[1].options?.body)), {
    operation: "start",
    input: body,
  });
  assert.equal(requests[1].options?.signal, signal);
  const file = new File(["bytes"], "原始图片.png", { type: "image/png" });
  await capture(
    uploadWorkflowImage("https://synthetic.invalid", file, signal),
    "uploadHttpFailed",
    503,
  );
  assert.equal(requests[2].options?.body, file);
  assert.equal(requests[2].options?.signal, signal);
  await capture(
    uploadWorkflowImage("https://synthetic.invalid", new File([], "empty.png")),
    "uploadSize",
  );
  await capture(
    uploadWorkflowImage(
      "https://synthetic.invalid",
      new File(["x"], "bad.txt"),
    ),
    "uploadType",
  );
  assert.equal(requests.length, 3, "invalid uploads send no request");
  response = () => Response.json({ assetId: "invalid" });
  await capture(
    uploadWorkflowImage("https://synthetic.invalid", file),
    "uploadInvalidAsset",
  );
  response = () =>
    Response.json({ message: { raw: "not a message" } }, { status: 502 });
  await capture(
    workflowApi("https://synthetic.invalid", "/catalog"),
    "serviceHttpUnavailable",
    502,
  );
  const calls = requests.length;
  const initial = errors.map((error) => error.message);
  const texts = errors.map(() => new Set<string>());
  for (const locale of locales) {
    await language.systemChanged([locale]);
    errors.forEach((error, index) => {
      assert.equal(errorMessage(error), error.text);
      assert.equal(
        error.message,
        initial[index],
        "legacy message remains a readable throw-time snapshot",
      );
      texts[index].add(messageText(errorMessage(error)));
    });
  }
  assert.ok(texts.every((values) => values.size === 6));
  assert.equal(
    requests.length,
    calls,
    "translation neither repeats nor retries requests",
  );
  response = () =>
    Response.json({ message: "Original upstream error" }, { status: 409 });
  await assert.rejects(
    workflowApi("https://synthetic.invalid", "/runs"),
    (error) =>
      error instanceof WorkflowApiError &&
      error.status === 409 &&
      errorMessage(error) === "Original upstream error",
  );
  const payload = { id: "original-id", name: "用户名称" };
  response = () => Response.json(payload);
  assert.deepEqual(
    await workflowApi("https://synthetic.invalid", "/catalog"),
    payload,
  );
  const abort = new DOMException("Cancelled", "AbortError");
  globalThis.fetch = async () => {
    throw abort;
  };
  await assert.rejects(
    workflowApi("https://synthetic.invalid", "/runs"),
    (error) => error === abort,
  );
});

test("path picker and login window fallbacks preserve semantic messages and delegate available native methods once", async (t) => {
  const originals = new Map(
    ["window", "open"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const originalLocale = language.getSnapshot().locale;
  t.after(async () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await language.systemChanged([originalLocale]);
  });
  const host: {
    platform: string;
    workflowFiles?: { choose(kind: string): Promise<string | null> };
    openExternal?: (url: string) => Promise<void>;
  } = { platform: "desktop" };
  Object.defineProperty(globalThis, "window", {
    value: { auraHost: host },
    configurable: true,
  });
  Object.defineProperty(globalThis, "open", {
    value: () => null,
    configurable: true,
  });
  const errors: MessageError[] = [];
  const collect = (key: string) => (error: unknown) => {
    assert.ok(error instanceof MessageError);
    assert.equal(typeof error.text === "object" && error.text.key, key);
    errors.push(error);
    return true;
  };
  await assert.rejects(
    chooseWorkflowPath("image"),
    collect("pickerDisconnected"),
  );
  host.platform = "web";
  await assert.rejects(
    chooseWorkflowPath("directory"),
    collect("pickerDesktopOnly"),
  );
  await assert.rejects(
    openExternal("https://auth.example.invalid"),
    collect("popupBlocked"),
  );
  const samples = errors.map(() => new Set<string>());
  for (const locale of locales) {
    await language.systemChanged([locale]);
    errors.forEach((error, index) =>
      samples[index].add(messageText(errorMessage(error))),
    );
  }
  assert.ok(samples.every((values) => values.size === 6));
  const paths: string[] = [];
  host.workflowFiles = {
    choose: async (kind) => {
      paths.push(kind);
      return kind === "image" ? "C:/原始图片.png" : null;
    },
  };
  assert.equal(await chooseWorkflowPath("image"), "C:/原始图片.png");
  assert.equal(await chooseWorkflowPath("directory"), null);
  assert.deepEqual(paths, ["image", "directory"]);
  const urls: string[] = [];
  host.openExternal = async (url) => {
    urls.push(url);
  };
  await openExternal("https://auth.example.invalid/original");
  assert.deepEqual(urls, ["https://auth.example.invalid/original"]);
});
