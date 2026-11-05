import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  SubprocessRuntime,
  SubprocessTerminalHandle,
} from "@deepseek-ai/dsh-subprocess";
import type {
  WorkspaceTerminalInfo,
  WorkspaceTerminalOutput,
} from "@aura/protocol/types";
import { FlowError } from "@aura/protocol/errors";

const MAX_OUTPUT = 1_048_576;
const PAGE_SIZE = 65_536;

interface TerminalRecord {
  info: WorkspaceTerminalInfo;
  handle: SubprocessTerminalHandle;
  posix: boolean;
  output: string;
  start: number;
  inspectedAt: number;
  answeredBefore: number;
  closing?: Promise<void>;
}

/** User-owned workspace PTYs, independent of model sessions and HTTP clients. */
export class WorkspaceTerminals {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<WorkspaceTerminalInfo>>();
  private readonly subprocess: Pick<
    SubprocessRuntime,
    "terminalEnvironment" | "resolveExecutable" | "spawnTerminal"
  >;
  private readonly directory: (projectId: string) => string;

  constructor(
    subprocess: Pick<
      SubprocessRuntime,
      "terminalEnvironment" | "resolveExecutable" | "spawnTerminal"
    >,
    directory: (projectId: string) => string,
  ) {
    this.subprocess = subprocess;
    this.directory = directory;
  }

  list(projectId: string): WorkspaceTerminalInfo[] {
    this.directory(projectId);
    return [...this.records.values()]
      .filter((record) => record.info.projectId === projectId)
      .map((record) => ({ ...record.info }));
  }

  open(
    projectId: string,
    cols: number,
    rows: number,
  ): Promise<WorkspaceTerminalInfo> {
    const operation = this.spawn(projectId, cols, rows);
    this.pending.add(operation);
    void operation
      .finally(() => this.pending.delete(operation))
      .catch(() => {});
    return operation;
  }

  private async spawn(
    projectId: string,
    cols: number,
    rows: number,
  ): Promise<WorkspaceTerminalInfo> {
    const cwd = this.directory(projectId);
    this.lifetime.signal.throwIfAborted();
    if (this.records.size + this.pending.size >= 24)
      throw new FlowError("打开的终端过多，请先关闭不用的终端。", 409);
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(20_000),
    ]);
    const environment = await this.subprocess.terminalEnvironment(signal);
    let shell: string;
    if (environment.platform === "windows") {
      shell = await this.subprocess
        .resolveExecutable("pwsh.exe", undefined, signal)
        .catch(() =>
          this.subprocess.resolveExecutable(
            "powershell.exe",
            undefined,
            signal,
          ),
        );
    } else {
      shell = await this.subprocess.resolveExecutable(
        environment.defaultShell ?? "sh",
        undefined,
        signal,
      );
    }
    const handle = await this.subprocess.spawnTerminal({
      argv:
        environment.platform === "windows"
          ? [shell, "-NoLogo", "-NoProfile"]
          : [shell, "-i"],
      cwd,
      cols,
      rows,
      terminalType: "xterm-256color",
      shellActivity: true,
      // Cold shells and ConPTY hosts need time to publish exit before escalation.
      graceMs: 3_000,
      signal,
    });
    if (this.lifetime.signal.aborted) {
      await handle.terminate();
      this.lifetime.signal.throwIfAborted();
    }
    const info: WorkspaceTerminalInfo = {
      id: `terminal-${randomUUID()}`,
      projectId,
      directory: cwd,
      title:
        environment.platform === "windows" ? "PowerShell" : basename(shell),
      createdAt: Date.now(),
      status: "running",
      activity: "unknown",
    };
    const record: TerminalRecord = {
      info,
      handle,
      posix: environment.platform === "posix",
      output: "",
      start: 0,
      inspectedAt: 0,
      answeredBefore: 0,
    };
    this.records.set(info.id, record);
    handle.output.setEncoding("utf8");
    handle.output.on("data", (chunk: string) => {
      record.output += chunk;
      if (record.output.length > MAX_OUTPUT) {
        const dropped = record.output.length - MAX_OUTPUT;
        record.output = record.output.slice(dropped);
        record.start += dropped;
      }
    });
    handle.output.on("error", () => {
      info.status = "error";
      info.activity = "unknown";
    });
    void handle.done.then(
      (outcome) => {
        info.status = "exited";
        info.activity = "idle";
        if (outcome.exitCode !== null) info.exitCode = outcome.exitCode;
      },
      () => {
        info.status = "error";
        info.activity = "unknown";
      },
    );
    return { ...info };
  }

  async read(id: string, cursor: number): Promise<WorkspaceTerminalOutput> {
    const record = this.require(id);
    if (
      record.info.status === "running" &&
      !record.closing &&
      Date.now() - record.inspectedAt > 1_000
    ) {
      record.inspectedAt = Date.now();
      record.info.activity = await record.handle.inspectActivity().then(
        (activity) => activity.state,
        () => "unknown" as const,
      );
    }
    const end = record.start + record.output.length;
    const reset = cursor < record.start || cursor > end;
    const position = reset ? record.start : cursor;
    const raw = record.output.slice(
      position - record.start,
      position - record.start + PAGE_SIZE,
    );
    // Replaying already answered device queries would inject unsolicited
    // replies into the live shell's current input after a page reload.
    const data = raw.replace(
      // eslint-disable-next-line no-control-regex -- ANSI device queries must not be answered again during replay.
      /\u001b\[[?>]?[\d;]*[cn]/gu,
      (query, offset: number) =>
        position + offset < record.answeredBefore ? "" : query,
    );
    return {
      terminal: { ...record.info },
      data,
      cursor: position + raw.length,
      reset,
    };
  }

  async write(id: string, data: string): Promise<void> {
    const record = this.require(id);
    if (record.info.status !== "running" || record.closing)
      throw new FlowError("终端已退出，请新建终端。", 409);
    await record.handle.write(data);
    // eslint-disable-next-line no-control-regex -- Recognize ANSI device replies to advance the replay boundary.
    if (/\u001b\[[?>]?[\d;]*[cRn]/u.test(data))
      record.answeredBefore = record.start + record.output.length;
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const record = this.require(id);
    if (record.info.status === "running" && !record.closing)
      await record.handle.resize(cols, rows);
  }

  async closeTerminal(id: string, force: boolean): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (record.closing) return record.closing;
    record.closing = this.terminate(record, force);
    try {
      await record.closing;
      this.records.delete(id);
    } finally {
      record.closing = undefined;
    }
  }

  private async terminate(
    record: TerminalRecord,
    force: boolean,
  ): Promise<void> {
    let idle = false;
    if (!force && record.info.status === "running") {
      idle = (await record.handle.inspectActivity()).state === "idle";
      if (!idle)
        throw new FlowError(
          "终端可能仍有任务运行，关闭将结束其中的进程。",
          409,
        );
    }
    if (record.posix && idle) {
      // Interactive shells can ignore TERM. Hang up only a verified idle shell;
      // DSH still owns and joins cleanup of the complete terminal session.
      try {
        await record.handle.signalForeground("SIGHUP");
      } catch {
        // The shell may already have exited; terminate remains authoritative.
      }
    }
    await record.handle.terminate();
  }

  async close(): Promise<void> {
    this.lifetime.abort(new Error("Terminal service closed"));
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled(
      [...this.records.keys()].map((id) => this.closeTerminal(id, true)),
    );
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Terminal cleanup failed",
      );
  }

  async closeProject(projectId: string): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.info.projectId === projectId)
        .map((record) => this.closeTerminal(record.info.id, true)),
    );
  }

  private require(id: string): TerminalRecord {
    const record = this.records.get(id);
    if (!record)
      throw new FlowError("终端已退出或服务已重启，请新建终端。", 404);
    this.directory(record.info.projectId);
    return record;
  }
}
