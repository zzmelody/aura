import assert from "node:assert/strict";
import test from "node:test";
import {
  MessageError,
  errorMessage,
  language,
  locales,
  messageText,
} from "@aura/i18n/runtime";
import { apiErrorCodes } from "@aura/protocol/errors";
import { apiErrorText, flowFailureText } from "../src/api-error-messages.ts";
import {
  workflowApi,
  uploadWorkflowImage,
  WorkflowApiError,
} from "../src/workflowSessions.ts";
import { invokePluginPage } from "../src/pluginPages.ts";
import { codingTurn, renameProject } from "../src/features/coding/api.ts";
import { applyTurnEvent, newTurn } from "../src/features/coding/turns.ts";
import { uploadChatImage } from "../src/chatImages.ts";

test("title and compaction notices translate across six languages without replaying requests and preserve legacy text", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocale = language.getSnapshot().locale;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await language.systemChanged([originalLocale]);
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      [
        ...["conversation_title_fallback", "auto_compaction_incomplete"].map(
          (code) => ({
            type: "notice",
            id: code,
            text: "legacy notice",
            details: { code, params: { token: "private" } },
            at: 1,
          }),
        ),
        { type: "notice", id: "old", text: "older server notice", at: 2 },
        {
          type: "notice",
          id: "future",
          text: "future server notice",
          details: { code: "future", params: { token: "private" } },
          at: 3,
        },
        { type: "done" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
  };
  let turn = newTurn("notice", "Original prompt", 1);
  for await (const event of codingTurn(
    "https://synthetic.invalid",
    { sessionId: "notice", prompt: "Original prompt", mode: "demo" },
    new AbortController().signal,
  ))
    if (event.type === "notice") turn = applyTurnEvent(turn, event);
  const notices = turn.timeline.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 4);
  assert.deepEqual(notices[0]?.text, {
    namespace: "apiErrors",
    key: "conversation_title_fallback",
  });
  assert.equal(notices[2]?.text, "older server notice");
  assert.equal(notices[3]?.text, "future server notice");
  assert.doesNotMatch(JSON.stringify(turn), /private/u);
  const titleTranslations = new Set<string>();
  const compactionTranslations = new Set<string>();
  for (const locale of locales) {
    await language.systemChanged([locale]);
    titleTranslations.add(messageText(notices[0]!.text));
    compactionTranslations.add(messageText(notices[1]!.text));
  }
  assert.equal(titleTranslations.size, 6);
  assert.equal(compactionTranslations.size, 6);
  assert.equal(requests, 1);
  assert.equal(turn.prompt, "Original prompt");
});

test("plugin literals retain language choice, English fallback and template-looking user characters", async (t) => {
  const original = language.getSnapshot().locale;
  t.after(() => language.systemChanged([original]));
  const translations = {
    en: "Keep {{literal}} <b>text</b>",
    "zh-CN": "保留 {{literal}} <b>文字</b>",
  };
  const reference = apiErrorText(
    { code: "plugin_failure", params: { translations } },
    "fallback",
  );
  for (const locale of locales) {
    await language.systemChanged([locale]);
    assert.equal(
      messageText(reference),
      locale === "zh-CN" ? translations["zh-CN"] : translations.en,
    );
  }
});

test("HTTP error codes remain live across six languages without replaying requests or accepting unrecognized parameters", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocale = language.getSnapshot().locale;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await language.systemChanged([originalLocale]);
  });
  await language.systemChanged(["en"]);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      {
        message: "compatibility text",
        code: "image_too_large",
        params: { limitMiB: 32, path: "private", token: "private" },
      },
      { status: 413 },
    );
  };
  const signal = new AbortController().signal;
  const file = new File(["fixture"], "原始图片.png", { type: "image/png" });
  const body = {
    requestId: "original-command-id",
    input: { text: "用户原文" },
  };
  const endpoint = "https://synthetic.invalid";
  const operations = [
    () => workflowApi(endpoint, "/fixture/runs", body, signal),
    () => uploadWorkflowImage(endpoint, file, signal),
    () => invokePluginPage(endpoint, "fixture", "start", body, signal),
    () => renameProject(endpoint, "project", "用户原文", signal),
    () => uploadChatImage(endpoint, file, signal),
  ];
  const errors: MessageError[] = [];
  for (const operation of operations)
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof MessageError);
      assert.deepEqual(error.text, {
        namespace: "apiErrors",
        key: "image_too_large",
        values: { limitMiB: 32 },
      });
      assert.equal(error.message, "The image must not exceed 32 MiB.");
      if (error instanceof WorkflowApiError) assert.equal(error.status, 413);
      errors.push(error);
      return true;
    });
  assert.equal(calls.length, operations.length);
  assert.ok(calls.every((call) => call.init?.signal === signal));
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), body);
  assert.equal(calls[1].init?.body, file);
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
    operation: "start",
    input: body,
  });
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
    title: "用户原文",
  });
  assert.equal(calls[4].init?.body, file);
  const references = [
    ...[
      "contribution_conflict",
      "action_missing",
      "flow_missing",
      "action_tool_conflict",
      "flow_service_missing",
      "flow_permission_missing",
      "flow_child_revision_missing",
      "flow_step_duplicate",
      "flow_scope_duplicate",
      "flow_replay_step",
      "flow_replay_action",
      "flow_preset_missing",
    ].map((code) =>
      apiErrorText({ code, params: { id: "fixture/step" } }, "fallback"),
    ),
    ...["flow_depth_limit", "flow_step_limit", "flow_agent_timeout"].map(
      (code) => apiErrorText({ code, params: { limit: 8 } }, "fallback"),
    ),
    ...[
      { code: "flow_cycle", params: { ids: ["first", "second", "first"] } },
      {
        code: "conversation_tools_missing",
        params: { tools: ["read_file", "write_file"] },
      },
      {
        code: "action_execution_failed",
        params: { id: "fixture/action", reason: "TOOL_TIMEOUT" },
      },
      { code: "flow_source_promise", params: { line: 12, method: "all" } },
      {
        code: "flow_source_root",
        params: { line: 8, context: "ctx", operation: "agent" },
      },
      {
        code: "flow_model_config_unavailable",
        params: {
          reason: "UNKNOWN_MODEL",
          provider: "synthetic",
          model: "fixture",
          effort: "medium",
        },
      },
    ].map((details) => apiErrorText(details, "fallback")),
    ...[
      "invalid_type",
      "too_small",
      "too_big",
      "invalid_format",
      "invalid_value",
      "unrecognized_keys",
      "invalid_union",
      "invalid_key",
      "invalid_element",
      "not_multiple_of",
    ].map((reason) =>
      apiErrorText(
        {
          code: "validation_failed",
          params: {
            target: "configuration",
            issues: [{ path: "OriginalField", reason }],
            remaining: 0,
          },
        },
        "fallback",
      ),
    ),
    apiErrorText(
      {
        code: "validation_failed",
        params: {
          target: "configuration",
          issues: [
            { path: "value", reason: "too_small", limit: 2, inclusive: false },
          ],
          remaining: 2,
        },
      },
      "fallback",
    ),
    apiErrorText(
      {
        code: "validation_failed",
        params: {
          target: "configuration",
          issues: [
            { path: "value", reason: "too_big", limit: 2, inclusive: false },
          ],
          remaining: 1,
        },
      },
      "fallback",
    ),
    apiErrorText(
      {
        code: "validation_failed",
        params: {
          target: "flow_input",
          issues: [
            { path: "task", reason: "invalid_type", expected: "string" },
            { path: "count", reason: "too_small", limit: 2 },
          ],
          remaining: 5,
        },
      },
      "fallback",
    ),
    apiErrorText(
      { code: "json_not_serializable", params: { target: "flow_output" } },
      "fallback",
    ),
    apiErrorText(
      {
        code: "json_too_large",
        params: { target: "flow_input", limitBytes: 256 },
      },
      "fallback",
    ),
    flowFailureText("legacy", {
      failure: { code: "model_http_failed", params: { status: 429 } },
      uncertainty: "agent_result_unknown",
      child: { id: "child-flow", phase: "failed" },
    }),
    ...apiErrorCodes.map((code) => apiErrorText({ code }, "fallback")),
    apiErrorText(
      { code: "model_codex_unsupported", params: { model: "gpt-5.4-mini" } },
      "fallback",
    ),
    apiErrorText(
      { code: "model_http_failed", params: { status: 429 } },
      "fallback",
    ),
    apiErrorText(
      {
        code: "model_selection_unavailable",
        params: { reason: "UNKNOWN_MODEL" },
      },
      "fallback",
    ),
    apiErrorText(
      { code: "flow_request_too_large", params: { limitKiB: 256 } },
      "fallback",
    ),
  ];
  const rendered = new Set<string>();
  for (const locale of locales) {
    await language.systemChanged([locale]);
    for (const reference of references) {
      assert.notEqual(typeof reference, "string");
      const text = messageText(reference);
      assert.ok(text.length > 0);
      assert.equal(text.includes("apiErrors:"), false);
      assert.equal(text.includes("{{"), false);
    }
    for (const error of errors) {
      const text = messageText(errorMessage(error));
      assert.ok(text.includes("32"));
      assert.equal(text.includes("private"), false);
      rendered.add(text);
      assert.equal(
        error.message,
        "The image must not exceed 32 MiB.",
        "legacy Error.message remains the readable throw-time snapshot",
      );
    }
  }
  assert.equal(rendered.size, 6);
  assert.equal(calls.length, operations.length);
  assert.equal(
    apiErrorText(
      {
        code: "future",
        params: { token: "private" },
        message: "older server message",
      },
      "fallback",
    ),
    "older server message",
  );
  assert.equal(
    apiErrorText(
      { code: "image_too_large", params: { limitMiB: "private" } },
      "fallback",
    ),
    "fallback",
  );
  assert.equal(
    apiErrorText({ message: { path: "private" } }, "fallback"),
    "fallback",
  );
  assert.deepEqual(
    apiErrorText(
      {
        code: "service_closing",
        params: { token: "private" },
        message: "compatibility",
      },
      "fallback",
    ),
    { namespace: "apiErrors", key: "service_closing" },
  );
});
