import assert from "node:assert/strict";
import test from "node:test";
import {
  loadToolLayouts,
  parseToolLayout,
  saveToolLayout,
} from "../src/features/coding/tool-layout.ts";

test("saved browsers reject credentials, foreign ids and bad field types", () => {
  const valid = {
    id: "browser-00000000-0000-4000-8000-000000000001",
    title: "页",
    url: "https://example.com/",
  };
  assert.ok(parseToolLayout({ browsers: [valid] }));
  assert.ok(parseToolLayout({ browsers: [{ ...valid, url: "" }] }));
  for (const browser of [
    { ...valid, url: "https://user:pass@example.com/" },
    { ...valid, url: "javascript:alert(1)" },
    { ...valid, url: "file:///etc/hosts" },
    { ...valid, id: "terminal-1" },
    { ...valid, title: 1 },
  ])
    assert.equal(parseToolLayout({ browsers: [browser] }), undefined);
  assert.equal(parseToolLayout({ browsers: [], visible: "yes" }), undefined);
  assert.equal(parseToolLayout(null), undefined);
});

test("unavailable storage leaves layouts usable in memory", () => {
  const broken = {
    get length(): number {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assert.deepEqual(loadToolLayouts(broken), {});
  assert.doesNotThrow(() =>
    saveToolLayout("owner", { browsers: [], visible: true }, broken),
  );
});

test("a malformed saved tool layout does not block or rewrite the other layouts on startup", () => {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),
  };
  const brokenKey = "aura.coding.tools.v1.broken";
  const browser = {
    id: "browser-00000000-0000-0000-0000-000000000000",
    title: "项目预览",
    url: "http://localhost:5173/",
  };
  const layout = { browsers: [browser], selected: browser.id, visible: true };
  entries.set(brokenKey, "invalid json");
  saveToolLayout("conversation", layout, storage);

  assert.deepEqual(loadToolLayouts(storage), { conversation: layout });
  assert.equal(entries.get(brokenKey), "invalid json");
  saveToolLayout("conversation", { browsers: [] }, storage);
  assert.deepEqual(loadToolLayouts(storage), {});
});
