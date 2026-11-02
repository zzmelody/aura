import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import headless from "@xterm/headless";
import type {
  SubprocessOutcome,
  SubprocessTerminalHandle,
} from "@deepseek-ai/dsh-subprocess";
import { WorkspaceTerminals } from "../src/coding/terminals.ts";

test("workspace terminals isolate output, fence unknown ids and wait for owned cleanup", async (t) => {
  const handles: Array<SubprocessTerminalHandle & { output: PassThrough }> = [];
  const inputs: string[] = [];
  let busy = true;
  let stopped = 0;
  const service = new WorkspaceTerminals(
    {
      terminalEnvironment: async () => ({ platform: "windows" }),
      resolveExecutable: async (name) => name,
      spawnTerminal: async (spec) => {
        assert.equal(spec.cwd, "registered-directory");
        assert.equal(
          spec.env,
          undefined,
          "credentials are never explicitly layered into PTYs",
        );
        assert.equal(spec.shellActivity, true);
        let done!: (outcome: SubprocessOutcome) => void;
        const handle = {
          pid: 1,
          output: new PassThrough(),
          done: new Promise<SubprocessOutcome>((resolve) => {
            done = resolve;
          }),
          write: async (data: string) => {
            inputs.push(data);
          },
          resize: async () => {},
          inspectForeground: async () => undefined,
          inspectActivity: async () => ({
            state: busy ? ("busy" as const) : ("idle" as const),
            revision: 0,
          }),
          signalForeground: async () => {
            assert.fail("Windows terminals must not receive POSIX hangups");
          },
          terminate: async () => {
            stopped++;
            done({ exitCode: 0, signal: null });
          },
        };
        handles.push(handle);
        return handle;
      },
    },
    (id) => {
      if (id !== "space") throw new Error("Unknown project");
      return "registered-directory";
    },
  );
  t.after(() => service.close());
  const first = await service.open("space", 80, 24);
  const second = await service.open("space", 90, 30);
  assert.notEqual(first.id, second.id);
  handles[0]!.output.write("first output");
  handles[1]!.output.write("second output");
  assert.equal((await service.read(first.id, 0)).data, "first output");
  assert.equal((await service.read(second.id, 0)).data, "second output");
  assert.equal((await service.read(first.id, 12)).data, "");
  await service.write(first.id, "abc\u0003");
  assert.deepEqual(inputs, ["abc\u0003"]);
  handles[0]!.output.write("\u001b[c");
  assert.ok((await service.read(first.id, 0)).data.includes("\u001b[c"));
  await service.write(first.id, "\u001b[?1;2c");
  assert.ok(
    !(await service.read(first.id, 0)).data.includes("\u001b[c"),
    "reattaching must not resend old device responses into the shell input",
  );
  await assert.rejects(service.closeTerminal(first.id, false), /任务运行/u);
  assert.equal(stopped, 0);
  await service.closeTerminal(first.id, true);
  assert.equal(stopped, 1);
  await assert.rejects(service.read(first.id, 0), /终端已退出/u);
  assert.equal(service.list("space").length, 1);
  handles[1]!.output.write("x".repeat(1_100_000));
  const truncated = await service.read(second.id, 0);
  assert.equal(truncated.reset, true);
  assert.equal(truncated.data.length, 65_536);
  busy = false;
  await service.closeTerminal(second.id, false);
  await assert.rejects(service.open("unknown", 80, 24), /Unknown project/);
});

test("idle POSIX terminals hang up promptly, fence input and wait for owned cleanup once", async (t) => {
  const inspection = Promise.withResolvers<{
    state: "idle";
    revision: number;
  }>();
  const cleanup = Promise.withResolvers<void>();
  const terminating = Promise.withResolvers<void>();
  const done = Promise.withResolvers<SubprocessOutcome>();
  const signals: string[] = [];
  let terminations = 0;
  let resizes = 0;
  const handle: SubprocessTerminalHandle = {
    pid: 1,
    output: new PassThrough(),
    done: done.promise,
    write: async () => assert.fail("closing terminals must reject new input"),
    resize: async () => {
      resizes++;
    },
    inspectForeground: async () => undefined,
    inspectActivity: () => inspection.promise,
    signalForeground: async (signal) => {
      signals.push(signal);
      done.resolve({ exitCode: null, signal });
      return 1;
    },
    terminate: () => {
      terminations++;
      terminating.resolve();
      return cleanup.promise;
    },
  };
  const service = new WorkspaceTerminals(
    {
      terminalEnvironment: async () => ({ platform: "posix" }),
      resolveExecutable: async (name) => name,
      spawnTerminal: async () => handle,
    },
    () => "registered-directory",
  );
  t.after(async () => {
    inspection.resolve({ state: "idle", revision: 1 });
    cleanup.resolve();
    await service.close();
  });
  const info = await service.open("space", 80, 24);
  const closing = service.closeTerminal(info.id, false);
  const duplicate = service.closeTerminal(info.id, true);
  await assert.rejects(service.write(info.id, "new input"), /终端已退出/u);
  await service.resize(info.id, 100, 30);
  assert.equal(resizes, 0);
  inspection.resolve({ state: "idle", revision: 1 });
  await terminating.promise;
  assert.deepEqual(signals, ["SIGHUP"]);
  assert.equal(terminations, 1);
  assert.equal(service.list("space").length, 1);
  cleanup.resolve();
  await Promise.all([closing, duplicate]);
  assert.deepEqual(service.list("space"), []);
});

for (const state of ["busy", "unknown", "unavailable", "idle"] as const) {
  test(`POSIX close preserves confirmation and cleanup with ${state} activity`, async (t) => {
    const done = Promise.withResolvers<SubprocessOutcome>();
    let hangups = 0;
    let terminations = 0;
    const handle: SubprocessTerminalHandle = {
      pid: 1,
      output: new PassThrough(),
      done: done.promise,
      write: async () => {},
      resize: async () => {},
      inspectForeground: async () => undefined,
      inspectActivity: async () => {
        if (state === "unavailable") throw new Error("Inspection unavailable");
        return { state, revision: 0 };
      },
      signalForeground: async () => {
        hangups++;
        throw new Error("Shell exited during hangup");
      },
      terminate: async () => {
        terminations++;
        done.resolve({ exitCode: 0, signal: null });
      },
    };
    const service = new WorkspaceTerminals(
      {
        terminalEnvironment: async () => ({ platform: "posix" }),
        resolveExecutable: async (name) => name,
        spawnTerminal: async () => handle,
      },
      () => "registered-directory",
    );
    t.after(() => service.close());
    const info = await service.open("space", 80, 24);
    if (state !== "idle") {
      await assert.rejects(service.closeTerminal(info.id, false));
      assert.equal(terminations, 0);
      assert.equal(hangups, 0);
      assert.equal(service.list("space").length, 1);
      await service.closeTerminal(info.id, true);
    } else {
      await service.closeTerminal(info.id, false);
    }
    assert.equal(hangups, state === "idle" ? 1 : 0);
    assert.equal(terminations, 1);
    assert.deepEqual(service.list("space"), []);
  });
}

test(
  "published DSH PTYs accept real shell input, retain state, resize and release the process",
  { timeout: 40_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-terminal-"));
    const ctx = new Context();
    const subprocess = new LocalSubprocessRuntime(ctx);
    const service = new WorkspaceTerminals(
      {
        terminalEnvironment: (signal) => subprocess.terminalEnvironment(signal),
        resolveExecutable: (command, env, signal) =>
          subprocess.resolveExecutable(command, env, signal),
        spawnTerminal: (spec) =>
          subprocess.spawnTerminal({
            ...spec,
            env: {
              ...spec.env,
              APPDATA: directory,
              LOCALAPPDATA: directory,
              USERPROFILE: directory,
              HISTFILE: join(directory, "shell-history"),
              ZDOTDIR: directory,
            },
          }),
      },
      () => directory,
    );
    t.after(async () => {
      try {
        await service.close();
        await ctx.root.fiber.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const info = await service.open("space", 80, 24);
    const screen = new headless.Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });
    t.after(() => screen.dispose());
    screen.onData((data) => {
      void service.write(info.id, data).catch(() => {});
    });
    const marker = "AURA_PTY_" + "READY";
    let cursor = 0;
    const read = async () => {
      const page = await service.read(info.id, cursor);
      cursor = page.cursor;
      if (page.data)
        await new Promise<void>((resolve) => screen.write(page.data, resolve));
      return page;
    };
    let startup = "";
    for (let index = 0; index < 100; index++) {
      const page = await read();
      startup += page.data;
      cursor = page.cursor;
      if (
        process.platform === "win32"
          ? startup.includes("PS ")
          : /[$#>%] /u.test(startup)
      )
        break;
      await delay(100);
    }
    await service.write(
      info.id,
      process.platform === "win32"
        ? "$auraPtyValue = 'AURA_PTY_' + 'READY'; Write-Output $auraPtyValue\r"
        : "AURA_PTY_VALUE='AURA_PTY_'\"READY\"; printf '%s\\n' \"$AURA_PTY_VALUE\"\r",
    );
    let output = "";
    for (let index = 0; index < 150; index++) {
      const page = await read();
      output += page.data;
      cursor = page.cursor;
      if (output.includes(marker)) break;
      await delay(100);
    }
    assert.ok(
      output.includes(marker),
      "a real PTY must return the shell output",
    );
    await service.resize(info.id, 100, 35);
    screen.resize(100, 35);
    await service.write(
      info.id,
      process.platform === "win32"
        ? "Write-Output ($auraPtyValue + '_PERSISTED')\r"
        : "printf '%s_PERSISTED\\n' \"$AURA_PTY_VALUE\"\r",
    );
    output = "";
    for (let index = 0; index < 100; index++) {
      const page = await read();
      output += page.data;
      cursor = page.cursor;
      if (output.includes(`${marker}_PERSISTED`)) break;
      await delay(100);
    }
    assert.ok(output.includes(`${marker}_PERSISTED`));
    let idle = false;
    if (process.platform !== "win32") {
      for (let index = 0; index < 30; index++) {
        if ((await read()).terminal.activity === "idle") {
          idle = true;
          break;
        }
        await delay(100);
      }
    }
    const closingAt = performance.now();
    await service.closeTerminal(info.id, !idle);
    const closeMs = performance.now() - closingAt;
    if (idle)
      assert.ok(
        closeMs < 2_000,
        `closing a POSIX shell must not wait through the Windows exit grace period (took ${Math.round(closeMs)} ms)`,
      );
    assert.deepEqual(service.list("space"), []);
  },
);
