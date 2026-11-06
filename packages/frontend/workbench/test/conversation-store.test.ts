import assert from "node:assert/strict";
import { errorMessage, language, messageText } from "@aura/i18n/runtime";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationStore } from "../src/features/coding/conversation-store.ts";
import type {
  ConversationCommand,
  ConversationSnapshot,
} from "@aura/protocol/conversation-channel";

const endpoint = "http://fixture";
const id = "session";
const epoch = "00000000-0000-4000-8000-000000000001";
const commandId = "00000000-0000-4000-8000-000000000002";
function snapshot(sequence = 1): ConversationSnapshot {
  return {
    version: 1,
    sessionId: id,
    cursor: `${epoch}:${sequence}`,
    running: false,
    hasMore: false,
    turns: [
      {
        turnId: "turn-0",
        prompt: "check",
        startedAt: 1,
        status: "complete",
        events: [{ type: "delta", text: "done" }],
      },
    ],
  };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail("condition did not become true");
}
function frame(type: string, value: ConversationSnapshot) {
  return new TextEncoder().encode(
    `event: ${type}\nid: ${value.cursor}\ndata: ${JSON.stringify(value)}\n\n`,
  );
}

test("views share a reader, reconnect using its cursor, and never stop execution on unsubscribe", async (t) => {
  let connections = 0;
  let disconnected = 0;
  const urls: string[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const store = new ConversationStore(async (input, init) => {
    const url = String(input);
    urls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/snapshot")) return Response.json(snapshot(connections));
    connections++;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(
          frame(
            connections === 1 ? "snapshot" : "reset",
            snapshot(connections),
          ),
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            disconnected++;
            try {
              value.close();
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  t.after(() => store.close());
  const first = store.subscribe(endpoint, id, () => undefined);
  const second = store.subscribe(endpoint, id, () => undefined);
  await until(() => store.view(endpoint, id).snapshot?.cursor === `${epoch}:1`);
  assert.equal(connections, 1);
  first();
  assert.equal(disconnected, 0);
  controller.close();
  await until(
    () =>
      connections === 2 &&
      store.view(endpoint, id).snapshot?.cursor === `${epoch}:2`,
  );
  assert.ok(
    urls.some((url) =>
      url.includes(`cursor=${encodeURIComponent(`${epoch}:1`)}`),
    ),
  );
  assert.equal(store.view(endpoint, id).snapshot?.turns.length, 1);
  second();
  await delay(10);
  assert.ok(disconnected >= 1);
  assert.ok(urls.every((url) => url.startsWith("GET ")));
});

test("a lost admission reply is resolved by querying its receipt without another POST", async (t) => {
  let posts = 0;
  const store = new ConversationStore(async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      throw new TypeError("lost response");
    }
    return Response.json({
      commandId,
      sessionId: id,
      executionId: commandId,
      status: "applied",
    });
  });
  t.after(() => store.close());
  const command: ConversationCommand = {
    commandId,
    type: "turn.start",
    input: { prompt: "check", mode: "demo" },
  };
  assert.equal((await store.submit(endpoint, id, command)).status, "applied");
  assert.equal(posts, 1);
  assert.equal(store.view(endpoint, id).pending, undefined);
});

test("an unknown admission stays pending until an explicit retry reuses the original command", async (t) => {
  const submitted: unknown[] = [];
  let accepted = false;
  const store = new ConversationStore(async (input, init) => {
    if (String(input).endsWith("/snapshot")) return Response.json(snapshot());
    if (init?.method === "POST") {
      submitted.push(JSON.parse(String(init.body)));
      if (submitted.length === 1) throw new TypeError("disconnected");
      accepted = true;
    }
    return accepted
      ? Response.json({
          commandId,
          sessionId: id,
          executionId: commandId,
          status: "accepted",
        })
      : Response.json({ message: "unknown" }, { status: 404 });
  });
  t.after(() => store.close());
  const command: ConversationCommand = {
    commandId,
    type: "turn.start",
    input: { prompt: "check", mode: "demo" },
  };
  let failure: unknown;
  await assert.rejects(
    store.submit(endpoint, id, command),
    (error: unknown) => {
      failure = error;
      assert.deepEqual(errorMessage(error), {
        namespace: "conversation",
        key: "commandRetained",
      });
      return true;
    },
  );
  await delay(100);
  assert.equal(submitted.length, 1);
  assert.equal(store.view(endpoint, id).pending?.commandId, commandId);
  const pending = store.view(endpoint, id).pending;
  const errorTexts = new Set<string>();
  const retainedTexts = new Set<string>();
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    await language.systemChanged([locale]);
    errorTexts.add(messageText(store.view(endpoint, id).error!));
    retainedTexts.add(messageText(errorMessage(failure)));
    assert.equal(store.view(endpoint, id).pending, pending);
    assert.equal(submitted.length, 1);
  }
  assert.equal(errorTexts.size, 6);
  assert.equal(retainedTexts.size, 6);
  await assert.rejects(
    store.submit(endpoint, id, { ...command, commandId: crypto.randomUUID() }),
    (error: unknown) => {
      assert.deepEqual(errorMessage(error), {
        namespace: "conversation",
        key: "previousCommandPending",
      });
      return true;
    },
  );
  await store.retryPending(endpoint, id);
  assert.deepEqual(submitted, [command, command]);
  assert.equal(store.view(endpoint, id).pending, undefined);
});

test("a transport failure retains the last execution state until reconnection", async (t) => {
  let fail = false;
  const active = snapshot();
  active.running = true;
  active.execution = {
    id: commandId,
    commandId,
    prompt: "check",
    startedAt: 1,
    status: "running",
  };
  const store = new ConversationStore(async () => {
    if (fail) throw new TypeError("network offline");
    return Response.json(active);
  });
  t.after(() => store.close());
  await store.refresh(endpoint, id);
  fail = true;
  await assert.rejects(store.refresh(endpoint, id));
  assert.equal(store.view(endpoint, id).snapshot?.execution?.status, "running");
});

test("a definite plain-text rejection clears the pending command instead of asking to retry it", async (t) => {
  const store = new ConversationStore(
    async () => new Response("request too large", { status: 413 }),
  );
  t.after(() => store.close());
  await assert.rejects(
    store.submit(endpoint, id, {
      commandId,
      type: "turn.start",
      input: { prompt: "check", mode: "demo" },
    }),
    { status: 413 },
  );
  assert.equal(store.view(endpoint, id).pending, undefined);
});

test("an older runtime asks for an update instead of reconnecting forever or submitting commands", async (t) => {
  let requests = 0;
  const store = new ConversationStore(async () => {
    requests++;
    return new Response(null, { status: 404 });
  });
  t.after(() => store.close());
  store.subscribe(endpoint, id, () => undefined);
  await until(() => store.view(endpoint, id).connection === "unsupported");
  const before = requests;
  await delay(600);
  assert.equal(requests, before);
  await assert.rejects(
    store.submit(endpoint, id, {
      commandId,
      type: "turn.start",
      input: { prompt: "check", mode: "demo" },
    }),
    { status: 426 },
  );
  assert.equal(
    requests,
    before,
    "an incompatible runtime must not receive commands",
  );
  assert.equal(store.view(endpoint, id).pending, undefined);
});

test("a supported runtime waits quietly for an unsaved conversation and connects after it is created", async (t) => {
  let created = false;
  const store = new ConversationStore(async (input, init) => {
    if (String(input).endsWith("/coding/channel"))
      return Response.json({ version: 1 });
    if (!created)
      return Response.json({ message: "not saved" }, { status: 404 });
    if (String(input).endsWith("/snapshot")) return Response.json(snapshot());
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame("snapshot", snapshot()));
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  t.after(() => store.close());
  store.subscribe(endpoint, id, () => undefined);
  await until(() => store.view(endpoint, id).connection === "waiting");
  created = true;
  await until(() => store.view(endpoint, id).snapshot !== undefined);
  assert.equal(store.view(endpoint, id).connection, "online");
});

test("a transient snapshot failure recovers its connection status while the event reader stays connected", async (t) => {
  let reads = 0;
  let connections = 0;
  const store = new ConversationStore(async (input, init) => {
    if (String(input).endsWith("/snapshot")) {
      if (++reads === 1)
        return Response.json({ message: "busy" }, { status: 503 });
      return Response.json(snapshot(2));
    }
    connections++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame("snapshot", snapshot()));
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  t.after(() => store.close());
  store.subscribe(endpoint, id, () => undefined);
  await until(() => store.view(endpoint, id).connection === "reconnecting");
  await until(() => store.view(endpoint, id).snapshot?.cursor === `${epoch}:2`);
  assert.equal(store.view(endpoint, id).connection, "online");
  assert.equal(connections, 1);
});

test("explicit reconnection recovers after replacing an older runtime", async (t) => {
  let upgraded = false;
  const store = new ConversationStore(async (input, init) => {
    if (!upgraded) return new Response(null, { status: 404 });
    if (String(input).endsWith("/snapshot")) return Response.json(snapshot());
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame("snapshot", snapshot()));
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  t.after(() => store.close());
  store.subscribe(endpoint, id, () => undefined);
  await until(() => store.view(endpoint, id).connection === "unsupported");
  upgraded = true;
  store.reconnect(endpoint, id);
  await until(() => store.view(endpoint, id).snapshot !== undefined);
  assert.equal(store.view(endpoint, id).connection, "online");
});

test("a missing command route reports the older runtime and clears its definite rejection", async (t) => {
  const store = new ConversationStore(
    async () => new Response(null, { status: 404 }),
  );
  t.after(() => store.close());
  await assert.rejects(
    store.submit(endpoint, id, {
      commandId,
      type: "turn.start",
      input: { prompt: "check", mode: "demo" },
    }),
    { status: 426 },
  );
  assert.equal(store.view(endpoint, id).connection, "unsupported");
  assert.equal(store.view(endpoint, id).pending, undefined);
});
