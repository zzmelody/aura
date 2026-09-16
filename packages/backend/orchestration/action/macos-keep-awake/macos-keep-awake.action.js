import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { defineAction } from "@aura/orchestration/action";

const execFileAsync = promisify(execFile);
const executable = "/usr/bin/caffeinate";

/** @typedef {{ pid: number, startedAt: string }} KeepAwakeState */

/**
 * @typedef {object} KeepAwakeResult
 * @property {"start" | "stop" | "status"} operation
 * @property {boolean} active
 * @property {number=} pid
 * @property {string=} startedAt
 */

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** @param {string} cwd */
function statePath(cwd) {
  return join(cwd, ".aura", "macos-keep-awake.json");
}

/** @param {string} path */
async function removeState(path) {
  await unlink(path).catch((error) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
}

/** @param {string} path @returns {Promise<KeepAwakeState | undefined>} */
async function readState(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const value = /** @type {unknown} */ (JSON.parse(raw));
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "startedAt" in value &&
      typeof value.startedAt === "string"
    )
      return { pid: value.pid, startedAt: value.startedAt };
  } catch {}
  await removeState(path);
  return undefined;
}

/** @param {string} path @param {KeepAwakeState} state */
async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await removeState(temporary);
  }
}

/** @param {number} pid */
async function isManagedProcess(pid) {
  try {
    process.kill(pid, 0);
    const { stdout } = await execFileAsync("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "comm=",
    ]);
    return basename(stdout.trim()) === "caffeinate";
  } catch {
    return false;
  }
}

/** @param {string} path */
async function activeState(path) {
  const state = await readState(path);
  if (!state) return undefined;
  if (await isManagedProcess(state.pid)) return state;
  await removeState(path);
  return undefined;
}

/** @param {AbortSignal} signal */
async function spawnCaffeinate(signal) {
  signal.throwIfAborted();
  const child = spawn(executable, ["-i"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGTERM");
    throw new Error("caffeinate 启动后没有返回进程 ID。");
  }
  await delay(25, undefined, { signal }).catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  if (!(await isManagedProcess(pid)))
    throw new Error("caffeinate 启动后意外退出。");
  child.unref();
  return pid;
}

/**
 * Starts, stops or inspects Aura's detached `caffeinate -i` process.
 * Exported for a focused lifecycle test; Action callers use the default export.
 * @param {{ cwd: string, signal: AbortSignal }} context
 * @param {"start" | "stop" | "status"} operation
 * @returns {Promise<KeepAwakeResult>}
 */
export async function manageKeepAwake(context, operation) {
  if (process.platform !== "darwin")
    throw new Error("macos-keep-awake 仅支持 macOS。");

  context.signal.throwIfAborted();
  const path = statePath(context.cwd);
  const current = await activeState(path);

  if (operation === "status")
    return current
      ? {
          operation,
          active: true,
          pid: current.pid,
          startedAt: current.startedAt,
        }
      : { operation, active: false };

  if (operation === "stop") {
    if (!current) return { operation, active: false };
    try {
      process.kill(current.pid, "SIGTERM");
    } catch (error) {
      if (!hasCode(error, "ESRCH")) throw error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      context.signal.throwIfAborted();
      if (!(await isManagedProcess(current.pid))) {
        await removeState(path);
        return { operation, active: false };
      }
      await delay(25, undefined, { signal: context.signal });
    }
    throw new Error("无法停止 Aura 启动的 caffeinate 进程。");
  }

  if (current)
    return {
      operation,
      active: true,
      pid: current.pid,
      startedAt: current.startedAt,
    };

  const pid = await spawnCaffeinate(context.signal);
  const state = { pid, startedAt: new Date().toISOString() };
  try {
    await writeState(path, state);
    context.signal.throwIfAborted();
  } catch (error) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    await removeState(path);
    throw error;
  }
  return { operation, active: true, ...state };
}

export default defineAction({
  title: "Mac 保持唤醒",
  description:
    "在 macOS 后台管理 caffeinate -i，防止系统因空闲自动休眠（包括电池供电）；允许显示器关闭，不阻止合盖、手动睡眠或低电量关机。start 重复调用不会创建多个进程，需用 stop 显式结束。",
  parameters: {
    operation: {
      type: "string",
      enum: ["start", "stop", "status"],
      required: true,
      description: "启动、停止或查看 Aura 管理的保持唤醒进程。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", required: true },
        active: { type: "boolean", required: true },
        pid: { type: "integer" },
        startedAt: { type: "string" },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 5_000,
  async execute(ctx, input) {
    return manageKeepAwake(ctx, input.operation);
  },
});
