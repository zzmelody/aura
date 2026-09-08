import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, restoreState, validateEndpoint } from "@aura/core";

test("restoration rejects incompatible data and sanitizes message status", () => {
  assert.deepEqual(restoreState(null), initialState());
  assert.deepEqual(restoreState({ version: 9, sessions: [] }), initialState());
  const restored = restoreState({
    version: 1,
    theme: "light",
    sessions: [
      null,
      {
        id: "s",
        title: "idea",
        updatedAt: 1,
        messages: [
          { id: "a", role: "assistant", text: "partial", status: "streaming" },
          { role: "system", text: "bad" },
        ],
      },
    ],
  });
  assert.equal(restored.theme, "light");
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].messages.length, 1);
  assert.equal(restored.sessions[0].messages[0].status, "stopped");
});

test("service URL admits only HTTP origins without credentials", () => {
  assert.equal(
    validateEndpoint(" http://192.168.1.2:4311/ "),
    "http://192.168.1.2:4311",
  );
  assert.equal(validateEndpoint("https://example.com"), "https://example.com");
  for (const input of [
    "javascript:alert(1)",
    "ftp://localhost",
    "http://user:secret@localhost",
    "http://localhost/api",
    "http://localhost?key=x",
    "bad",
  ])
    assert.equal(validateEndpoint(input), null);
});

test("restoration preserves the DSH Codex provider selection", () => {
  const restored = restoreState({ version: 1, provider: "codex", sessions: [] });
  assert.equal(restored.provider, "codex");
});
