import assert from "node:assert/strict";
import { test } from "node:test";
import { StartupCache } from "../src/startup-cache.ts";
import type {
  ChatModelCatalog,
  CodingConversationInfo,
} from "@aura/protocol/types";

const endpoint = "http://localhost:4311";
const catalog: ChatModelCatalog = {
  mode: "codex",
  defaultModel: "fixture",
  models: [{ id: "fixture", name: "Fixture", reasoningEfforts: [] }],
};
const projects = [{ id: "fixture", title: "Fixture", directory: "F:/fixture" }];
const conversations: CodingConversationInfo[] = [
  {
    id: "conversation",
    projectId: "fixture",
    title: "Saved conversation",
    createdAt: 1,
    updatedAt: 2,
  },
];

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return { values, storage, cache: new StartupCache(() => storage) };
}

test("another window restores public catalogs and projects within the same endpoint and mode", () => {
  const { cache, storage } = fixture();
  cache.saveModels(endpoint, catalog);
  cache.saveProjects(endpoint, projects);
  const next = new StartupCache(() => storage);
  assert.deepEqual(next.models(`${endpoint}/`, "codex"), catalog);
  assert.deepEqual(next.projects(endpoint), projects);
  assert.equal(next.models(endpoint, "lumina"), undefined);
  assert.equal(next.models("http://other:4311", "codex"), undefined);
  assert.equal(next.projects("http://other:4311"), undefined);
});

test("startup cache whitelists metadata and never saves unknown account or conversation fields", () => {
  const { cache, values } = fixture();
  cache.saveModels(endpoint, {
    ...catalog,
    ...{ apiKey: "fixture-secret", access_token: "fixture-secret" },
    models: [{ ...catalog.models[0]!, ...{ refresh_token: "fixture-secret" } }],
  });
  cache.saveProjects(endpoint, [
    {
      ...projects[0]!,
      ...{ messages: ["fixture-secret"], key: "fixture-secret" },
    },
  ]);
  const saved = [...values.values()].join("");
  assert.doesNotMatch(
    saved,
    /fixture-secret|apiKey|access_token|refresh_token|messages/u,
  );
  assert.deepEqual(cache.models(endpoint, "codex"), catalog);
  assert.deepEqual(cache.projects(endpoint), projects);
});

test("expired, corrupted, unsupported and oversized startup caches do not block live reads", (t) => {
  const { cache, storage, values } = fixture();
  const now = Date.now();
  cache.saveModels(endpoint, catalog);
  t.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1_000);
  assert.equal(cache.models(endpoint, "codex"), undefined);
  const key = [...values.keys()][0]!;
  for (const saved of [
    "broken",
    JSON.stringify({ version: 9 }),
    "x".repeat(1_000_001),
  ]) {
    storage.setItem(key, saved);
    assert.equal(cache.models(endpoint, "codex"), undefined);
  }
});

test("a valid empty project list replaces old entries and cache invalidation removes only the model scope", () => {
  const { cache } = fixture();
  cache.saveModels(endpoint, catalog);
  cache.saveModels("http://other:4311", catalog);
  cache.saveProjects(endpoint, projects);
  cache.saveProjects(endpoint, []);
  assert.deepEqual(cache.projects(endpoint), []);
  cache.forgetModels(endpoint);
  assert.equal(cache.models(endpoint, "codex"), undefined);
  assert.deepEqual(cache.models("http://other:4311", "codex"), catalog);
  assert.deepEqual(cache.projects(endpoint), []);
});

test("cache storage failures and sensitive endpoint URLs never persist user information", () => {
  const { cache, values } = fixture();
  for (const address of [
    "http://name:fixture-secret@localhost",
    "http://localhost?key=fixture-secret",
    "http://localhost#fixture-secret",
  ]) {
    cache.saveModels(address, catalog);
    cache.saveProjects(address, projects);
    cache.saveConversations(address, "fixture", conversations);
  }
  assert.equal(values.size, 0);
  const unavailable = new StartupCache(() => {
    throw new Error("denied");
  });
  assert.doesNotThrow(() => unavailable.saveModels(endpoint, catalog));
  assert.equal(unavailable.projects(endpoint), undefined);
});

test("cache scope count stays bounded and malformed live metadata never overwrites a good snapshot", () => {
  const { cache, values } = fixture();
  for (let id = 0; id < 20; id++) {
    cache.saveModels(`http://host-${id}:4311`, catalog);
    cache.saveProjects(`http://host-${id}:4311`, projects);
  }
  assert.equal(cache.models("http://host-0:4311", "codex"), undefined);
  assert.equal(cache.projects("http://host-0:4311"), undefined);
  const saved = JSON.parse([...values.values()][0]!);
  assert.equal(saved.models.length, 16);
  assert.equal(saved.projects.length, 8);
  cache.saveModels("http://host-19:4311", {
    ...catalog,
    models: [{ ...catalog.models[0]!, reasoningEfforts: [null] }],
  } as unknown as ChatModelCatalog);
  assert.deepEqual(cache.models("http://host-19:4311", "codex"), catalog);
});

test("sidebar restores conversation titles before any service read without restoring execution state", () => {
  const { cache, storage, values } = fixture();
  cache.saveProjects(endpoint, projects);
  cache.saveConversations(endpoint, "fixture", [
    {
      ...conversations[0]!,
      lastTurnStatus: "running",
      waitingForAnswer: true,
      ...{ messages: ["fixture-secret"], access_token: "fixture-secret" },
    },
  ]);
  const restored = new StartupCache(() => storage).sidebar(`${endpoint}/`);
  assert.deepEqual(restored, {
    projects,
    conversations: { fixture: conversations },
  });
  assert.doesNotMatch(
    [...values.values()].join(""),
    /fixture-secret|access_token|messages|lastTurnStatus|waitingForAnswer/u,
  );
  assert.deepEqual(cache.sidebar("http://other:4311"), {
    projects: [],
    conversations: {},
  });
});

test("empty conversation results and removed workspaces replace stale sidebar rows", () => {
  const { cache } = fixture();
  cache.saveProjects(endpoint, projects);
  cache.saveConversations(endpoint, "fixture", conversations);
  cache.saveConversations(endpoint, "fixture", []);
  assert.deepEqual(cache.sidebar(endpoint).conversations, { fixture: [] });
  cache.saveConversations(endpoint, "fixture", conversations);
  cache.saveProjects(endpoint, []);
  assert.deepEqual(cache.sidebar(endpoint), {
    projects: [],
    conversations: {},
  });
});

test("unchanged sidebar metadata avoids storage writes during status polling", () => {
  const { storage } = fixture();
  let writes = 0;
  const cache = new StartupCache(() => ({
    getItem: storage.getItem,
    setItem(key, value) {
      writes++;
      storage.setItem(key, value);
    },
  }));
  cache.saveProjects(endpoint, projects);
  cache.saveConversations(endpoint, "fixture", conversations);
  const initial = writes;
  cache.saveConversations(endpoint, "fixture", [
    { ...conversations[0]!, lastTurnStatus: "running" },
  ]);
  cache.saveConversations(endpoint, "fixture", [
    { ...conversations[0]!, lastTurnStatus: "complete" },
  ]);
  assert.equal(writes, initial);
  cache.saveConversations(endpoint, "fixture", [
    { ...conversations[0]!, title: "Renamed conversation" },
  ]);
  assert.equal(writes, initial + 1);
});

test("malformed list responses preserve the last sidebar snapshot and long lists stay bounded", () => {
  const { cache } = fixture();
  cache.saveProjects(endpoint, projects);
  cache.saveConversations(endpoint, "fixture", conversations);
  assert.doesNotThrow(() =>
    cache.saveConversations(
      endpoint,
      "fixture",
      {} as unknown as CodingConversationInfo[],
    ),
  );
  assert.deepEqual(
    cache.sidebar(endpoint).conversations.fixture,
    conversations,
  );
  const many = Array.from({ length: 250 }, (_, index) => ({
    ...conversations[0]!,
    id: `conversation-${index}`,
  }));
  cache.saveConversations(endpoint, "fixture", many);
  assert.deepEqual(
    cache.sidebar(endpoint).conversations.fixture,
    many.slice(0, 200),
  );
});

test("archived titles stay archived and malformed or expired sidebar snapshots are ignored", (t) => {
  const { cache, storage } = fixture();
  cache.saveProjects(endpoint, projects);
  const archived = [{ ...conversations[0]!, archivedAt: 3 }];
  cache.saveConversations(endpoint, "fixture", archived);
  cache.saveConversations(endpoint, "fixture", [
    { ...conversations[0]!, projectId: "wrong-workspace" },
  ]);
  assert.deepEqual(new StartupCache(() => storage).sidebar(endpoint), {
    projects,
    conversations: { fixture: archived },
  });
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1_000);
  assert.deepEqual(cache.sidebar(endpoint), {
    projects: [],
    conversations: {},
  });
});
