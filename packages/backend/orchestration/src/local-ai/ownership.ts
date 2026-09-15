import {
  extendWin32ProcessBindings,
  isNullPtr,
  throwLastError,
  type NativePtr,
} from "@deepseek-ai/dsh-win32-process";

function bindings() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("本地 AI 部署目前只支持 Windows x64。");
  return extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openProcess: bind(kernel32, "OpenProcess", "void *", [
      "uint32",
      "int",
      "uint32",
    ]) as (access: number, inherit: number, pid: number) => NativePtr,
    createMutex: bind(kernel32, "CreateMutexW", "void *", [
      "void *",
      "int",
      "str16",
    ]) as (attributes: null, owner: number, name: string) => NativePtr,
    releaseMutex: bind(kernel32, "ReleaseMutex", "int", ["void *"]) as (
      handle: NativePtr,
    ) => number,
    isProcessInJob: bind(kernel32, "IsProcessInJob", "int", [
      "void *",
      "void *",
      "void *",
    ]) as (process: NativePtr, job: NativePtr, result: Buffer) => number,
  }));
}

const heldLeases = new Set<string>();

/** Cross-host GPU lease. Unlike a lock file/semaphore it is released on a crash. */
export function acquireGpuLease(
  name = "Local\\Aura.LocalAI.CUDA0",
): () => void {
  // Win32 mutexes are recursive on the same thread; independent local owners aren't.
  if (heldLeases.has(name)) throw new Error("本地 AI 显卡已有持有者。");
  const api = bindings();
  const mutex = api.createMutex(null, 0, name);
  if (isNullPtr(mutex)) throwLastError(api, "CreateMutexW");
  const result = api.waitForSingleObject(mutex, 0);
  // WAIT_ABANDONED grants ownership after another host died.
  if (result !== 0 && result !== 0x80) {
    api.closeHandle(mutex);
    throw new Error("另一 Aura 进程正在使用本地 AI 显卡，请稍后重试。");
  }
  heldLeases.add(name);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    api.releaseMutex(mutex);
    api.closeHandle(mutex);
    heldLeases.delete(name);
  };
}

/** Attach only the gated worker, never Aura or an unrelated Python process. */
export function ownProcessTree(pid: number) {
  const api = bindings();
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, "CreateJobObjectW");
  try {
    // Windows x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION ABI, class 9.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!api.setInformationJobObject(job, 9, limits, limits.length))
      throwLastError(api, "SetInformationJobObject");
    const child = api.openProcess(0x100 | 0x1, 0, pid); // SET_QUOTA | TERMINATE
    if (isNullPtr(child)) throwLastError(api, "OpenProcess");
    try {
      if (!api.assignProcessToJobObject(job, child))
        throwLastError(api, "AssignProcessToJobObject");
    } finally {
      api.closeHandle(child);
    }
  } catch (error) {
    api.closeHandle(job);
    throw error;
  }
  let closed = false;
  return {
    contains(pid: number) {
      if (closed || !Number.isSafeInteger(pid) || pid <= 0) return false;
      const process = api.openProcess(0x0400, 0, pid); // PROCESS_QUERY_INFORMATION
      if (isNullPtr(process)) return false;
      try {
        const result = Buffer.alloc(4);
        return Boolean(
          api.isProcessInJob(process, job, result) && result.readUInt32LE(0),
        );
      } finally {
        api.closeHandle(process);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      // Non-inheritable job handle: an abruptly killed owner also kills all descendants.
      api.closeHandle(job);
    },
  };
}
