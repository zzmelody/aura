import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import * as JsonStorage from "@deepseek-ai/dsh-storage-json";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { CodingConversationIndex, codingDomainSpec } from "@aura/agent-runtime";
import { OrchestrationHost } from "../src/dsh/host.ts";
import { coldCodingHistory } from "@aura/agent-runtime/stored-history";

test("cancelling an unsupported cold read stops waiting for a starting executor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-cold-history-abort-"));
  const host = new OrchestrationHost({
    root,
    dshHome: join(root, "dsh"),
    modelURL: "http://127.0.0.1:1/v1",
  });
  let release!: (error: Error) => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  host.launch = async () =>
    new Promise((_resolve, reject) => {
      release = reject;
      enter();
    });
  t.after(async () => {
    release?.(new Error("Fixture executor stopped"));
    await host.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const abort = new AbortController();
  const reading = host.codingHistory(
    "coding-missing",
    { page: true },
    abort.signal,
  );
  await entered;
  const reason = new DOMException("Read cancelled", "AbortError");
  abort.abort(reason);
  await assert.rejects(reading, (error) => error === reason);
});

async function fingerprint(root: string): Promise<Array<[string, string]>> {
  const all = async (dir: string): Promise<string[]> =>
    (
      await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map((entry) =>
          entry.isDirectory()
            ? all(join(dir, entry.name))
            : [join(dir, entry.name)],
        ),
      )
    ).flat();
  return Promise.all(
    (await all(root)).sort().map(
      async (path) =>
        [
          relative(root, path),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ] as [string, string],
    ),
  );
}

test(
  "cold history restores main and fork logs without booting an executor or rewriting storage",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-cold-history-"));
    const hosts: OrchestrationHost[] = [];
    let server: ServerType | undefined;
    t.after(async () => {
      for (const host of hosts) if (!host.closed) await host.close();
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const flowRoot = join(root, "flows");
    await mkdir(flowRoot);
    let modelRequests = 0;
    const app = new Hono().post("/v1/chat/completions", (context) => {
      modelRequests++;
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "Synthetic history reply" },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
      server.once("error", reject);
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      defaultWorkspace: join(root, "workspace"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    const warm = new OrchestrationHost(options);
    hosts.push(warm);
    const project = (await warm.projects())[0]!;
    const main = "coding-cold-main";
    const send = (sessionId: string, prompt: string, forkFrom?: string) =>
      warm.coding(
        {
          sessionId,
          projectId: project.id,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
          ...(forkFrom ? { forkFrom } : {}),
        },
        () => {},
        AbortSignal.timeout(30_000),
      );
    for (let turn = 0; turn < 12; turn++)
      await send(main, `SYNTHETIC_PROMPT_${turn}`);
    const side = await warm.openCodingSide(main);
    await send(side.sessionId, "ONLY_CHILD_PROMPT", main);
    const expectedMain = await warm.codingHistory(main, { page: true });
    const cursor = {
      page: true,
      beforeSeq: expectedMain.beforeSeq,
      throughSeq: expectedMain.throughSeq,
    };
    const expectedOlder = await warm.codingHistory(main, cursor);
    const expectedSide = await warm.codingHistory(side.sessionId, {
      page: true,
    });
    await warm.close();
    const before = await fingerprint(options.dshHome);
    const cold = new OrchestrationHost(options);
    hosts.push(cold);
    let launches = 0;
    cold.launch = async () => {
      launches++;
      throw new Error("Executor must not start for a cold read");
    };
    const restored = await cold.codingHistory(main, { page: true });
    const fork = await cold.codingHistory(side.sessionId, { page: true });
    assert.deepEqual(restored, expectedMain);
    assert.equal(restored.hasMore, true);
    assert.deepEqual(await cold.codingHistory(main, cursor), expectedOlder);
    assert.deepEqual(fork, expectedSide);
    assert.deepEqual(
      fork.turns.map((turn) => turn.prompt),
      ["ONLY_CHILD_PROMPT"],
    );
    assert.equal(
      "events" in restored,
      false,
      "Raw persisted events never enter the HTTP DTO",
    );
    assert.equal(launches, 0);
    assert.equal(modelRequests, 13);
    assert.deepEqual(await fingerprint(options.dshHome), before);
    await assert.rejects(
      cold.codingHistory("ordinary-private-session", { page: true }),
      /不存在或已移除/u,
    );
    assert.equal(
      launches,
      0,
      "Unindexed logs stay private without starting an executor",
    );
    const abort = new AbortController();
    abort.abort(new DOMException("Cancelled", "AbortError"));
    await assert.rejects(
      cold.codingHistory(main, { page: true }, abort.signal),
      /Cancelled/u,
    );
    assert.equal(launches, 0);
    const context = new Context();
    try {
      const storageRoot = join(options.dshHome, "aura-flow-storages");
      await context.plugin(Storage);
      await context.plugin(JsonStorage, { root: storageRoot });
      const facility = new DomainFacility(context, { backend: "json" });
      const domain = await facility.open(codingDomainSpec);
      const records = [...domain.table("conversations").entries()];
      const index = new CodingConversationIndex(domain.table("conversations"));
      await index.archive(main, true);
      await assert.rejects(
        cold.codingHistory(side.sessionId, { page: true }),
        /不存在或已移除/u,
      );
      await index.close(main);
      await assert.rejects(
        cold.codingHistory(main, { page: true }),
        /不存在或已移除/u,
      );
      assert.equal(
        launches,
        0,
        "Permissions are checked again against the current index",
      );
      await domain.close();
      // Build an old-layout fixture through the same published storage API.
      const legacy = await facility.open({
        ...codingDomainSpec,
        layout: "single",
      });
      for (const [id, record] of records)
        await legacy.table("conversations").put(id, record);
      await legacy.close();
      await rm(join(storageRoot, codingDomainSpec.name), {
        recursive: true,
        force: true,
      });
      const legacyBefore = await fingerprint(options.dshHome);
      assert.deepEqual(
        await cold.codingHistory(main, { page: true }),
        expectedMain,
      );
      assert.deepEqual(
        await fingerprint(options.dshHome),
        legacyBefore,
        "Cold reads do not materialize or migrate the original legacy index",
      );
      assert.equal(launches, 0);
    } finally {
      await context.fiber.dispose();
    }
    const background = new OrchestrationHost(options);
    hosts.push(background);
    let ready = false;
    const opening = background.open().then(() => {
      ready = true;
    });
    const duringStartup = await background.codingHistory(main, { page: true });
    assert.deepEqual(duringStartup, expectedMain);
    assert.equal(
      ready,
      false,
      "History is delivered before the concurrently starting execution host is ready",
    );
    await opening;
    assert.equal(
      modelRequests,
      13,
      "Starting the execution host and reading history do not replay requests",
    );
    // Finish this concurrent fixture before fingerprinting the next isolated
    // read: its startup logger can still flush after the ready acknowledgement.
    await background.close();
    await writeFile(
      join(options.dshHome, "cordis.patch.yml"),
      "# User-owned profile overlay\n",
    );
    const overlaid = await fingerprint(options.dshHome);
    assert.equal(
      await coldCodingHistory(
        options.dshHome,
        main,
        {},
        new AbortController().signal,
      ),
      undefined,
    );
    assert.deepEqual(
      await fingerprint(options.dshHome),
      overlaid,
      "User storage overrides defer to their full profile loader",
    );
  },
);
