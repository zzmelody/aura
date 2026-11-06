import assert from "node:assert/strict";
import test from "node:test";
import { MessageError, errorMessage, messageText } from "@aura/plugin-ui";
import { language, locales } from "@aura/i18n/runtime";
import {
  nativeFailureCodes,
  isNativeFailure,
  type NativeFailure,
  type NativeHost,
} from "@aura/protocol/native-ui";
import type { BrowserHost } from "@aura/protocol/browser";
import { nativeCall } from "../src/native-messages.ts";
import { desktopBrowserHost } from "../src/platform.ts";
import { chooseWorkflowPath } from "../src/file-picker.ts";

test("native failure DTOs preserve codes across serialization and become live translated SDK errors without native retries", async (t) => {
  const original = language.getSnapshot().locale;
  t.after(() => language.systemChanged([original]));
  const errors: MessageError[] = [];
  let calls = 0;
  for (const code of nativeFailureCodes) {
    const result: unknown = JSON.parse(
      JSON.stringify({ type: "aura.native.failure", code }),
    );
    assert.ok(isNativeFailure(result));
    await assert.rejects(
      nativeCall(async () => {
        calls++;
        return result;
      }),
      (error) => {
        assert.ok(error instanceof MessageError);
        assert.deepEqual(error.text, { namespace: "native", key: code });
        errors.push(error);
        return true;
      },
    );
  }
  for (const value of [
    null,
    {},
    "fileNotFound",
    { type: "aura.native.failure", code: "unknown" },
  ])
    assert.equal(isNativeFailure(value), false);
  await assert.rejects(
    nativeCall(async () => ({
      type: "aura.native.failure",
      code: "futureCode",
      message: "/private/path",
    })),
    (error) => {
      assert.ok(error instanceof MessageError);
      assert.deepEqual(error.text, {
        namespace: "native",
        key: "operationFailed",
      });
      assert.equal(error.message.includes("/private/path"), false);
      errors.push(error);
      return true;
    },
  );
  const messages = errors.map(() => new Set<string>());
  for (const locale of locales) {
    await language.systemChanged([locale]);
    errors.forEach((error, index) =>
      messages[index].add(messageText(errorMessage(error))),
    );
  }
  assert.ok(messages.every((samples) => samples.size === 6));
  assert.equal(calls, nativeFailureCodes.length);
  assert.equal(await nativeCall(async () => null), null);
  assert.equal(
    await nativeCall(async () => "C:/original/name.png"),
    "C:/original/name.png",
  );
  assert.equal(await nativeCall(async () => undefined), undefined);
  const oldError = new Error("Legacy host message");
  await assert.rejects(
    nativeCall(async () => {
      throw oldError;
    }),
    (error) => error === oldError,
  );
});

test("browser bridge adapters keep their identity and pass each user action through once", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const original = language.getSnapshot().locale;
  t.after(async () => {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    await language.systemChanged([original]);
  });
  const calls: unknown[][] = [];
  const failure: NativeFailure = {
    type: "aura.native.failure",
    code: "browserAddressBlocked",
  };
  const reservation = {
    lease: "original-lease",
    partition: "original-partition",
  };
  const browser: NativeHost<BrowserHost> = {
    acquire: async (workspace) => {
      calls.push(["acquire", workspace]);
      return reservation;
    },
    navigate: async (id, url) => {
      calls.push(["navigate", id, url]);
      return failure;
    },
    release: async (id) => {
      calls.push(["release", id]);
    },
    openExternal: async (id) => {
      calls.push(["external", id]);
    },
  };
  const host = {
    browser,
    workflowFiles: {
      choose: async () => ({
        type: "aura.native.failure",
        code: "pickerFailed",
      }),
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: { auraHost: host },
    configurable: true,
  });
  const adapter = desktopBrowserHost()!;
  assert.equal(await adapter.acquire("original-workspace"), reservation);
  for (const locale of locales) {
    await language.systemChanged([locale]);
    assert.equal(desktopBrowserHost(), adapter);
  }
  assert.equal(calls.length, 1);
  await assert.rejects(
    adapter.navigate(reservation.lease, "file:///blocked"),
    (error) =>
      error instanceof MessageError &&
      typeof error.text === "object" &&
      error.text.key === "browserAddressBlocked",
  );
  await adapter.openExternal(reservation.lease);
  await adapter.release(reservation.lease);
  assert.deepEqual(calls, [
    ["acquire", "original-workspace"],
    ["navigate", "original-lease", "file:///blocked"],
    ["external", "original-lease"],
    ["release", "original-lease"],
  ]);
  await assert.rejects(
    chooseWorkflowPath("directory"),
    (error) =>
      error instanceof MessageError &&
      typeof error.text === "object" &&
      error.text.key === "pickerFailed",
  );
});
