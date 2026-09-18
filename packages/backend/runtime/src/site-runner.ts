import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { SiteProject, SiteStatus } from "@aura/protocol/types";
import {
  announcedSiteUrls,
  availableSitePort,
  localSiteUrl,
  portAvailable,
  siteOwnsPort,
  sitePort,
  siteResponds,
} from "./site-network.ts";
import { sitePortFlags, siteProjectInput } from "./site-project.ts";
import { spawnSite, stopSiteProcess } from "./site-process.ts";

export { describeProject } from "./site-project.ts";
export type { SiteProject, SiteStatus } from "@aura/protocol/types";

type Entry = {
  child: ChildProcess;
  project: SiteProject;
  output: string;
  cancelled: boolean;
};
type Options = {
  onStatus(status: SiteStatus): void;
  openPreview(url: string): Promise<void>;
  readinessTimeoutMs?: number;
};

/** One owned process tree. IPC hosts do not implement process or port policy. */
export class SiteRunner {
  private entry: Entry | null = null;
  private status: SiteStatus = { state: "idle" };
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private options: Options;

  constructor(options: Options) {
    this.options = options;
  }
  getStatus(): SiteStatus {
    return this.status;
  }
  private publish(status: SiteStatus): SiteStatus {
    this.status = status;
    this.options.onStatus(status);
    return status;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private live(entry: Entry): boolean {
    return (
      this.entry === entry &&
      !entry.cancelled &&
      Boolean(entry.child.pid) &&
      entry.child.exitCode === null &&
      entry.child.signalCode === null
    );
  }

  start(input: unknown): Promise<SiteStatus> {
    const revision = ++this.revision;
    return this.exclusive(async () => {
      try {
        if (revision !== this.revision) return this.status;
        const { project, command } = await siteProjectInput(input);
        await this.stopCurrent();
        if (revision !== this.revision) return this.status;
        this.publish({
          state: "starting",
          project,
          previewReady: false,
          message: "正在检查项目端口…",
        });
        const url = localSiteUrl(project.url);
        const preferred = sitePort(url);
        const hostname = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
        const supported = sitePortFlags(command, preferred, hostname) !== null;
        if (!supported && !(await portAvailable(preferred)))
          throw new Error(
            `端口 ${preferred} 已被占用。自定义启动脚本无法安全自动改端口，请同时修改脚本监听端口和预览地址，或自行停止占用服务后重试。Aura 不会结束其他服务。`,
          );
        const port = supported
          ? await availableSitePort(preferred)
          : preferred;
        const flags = supported
          ? sitePortFlags(command, port, hostname) ?? []
          : [];
        if (revision !== this.revision) return this.status;
        url.port = String(port);
        project.url = url.toString();
        const child = spawnSite(project, command, flags ?? []);
        const entry: Entry = { child, project, output: "", cancelled: false };
        this.entry = entry;
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => this.append(entry, String(chunk)));
        child.stderr?.on("data", (chunk) => this.append(entry, String(chunk)));
        child.once("error", (error) =>
          this.exited(entry, `无法启动项目：${error.message}`, true),
        );
        child.once("exit", (code, signal) =>
          this.exited(
            entry,
            code === 0
              ? "项目进程已结束。"
              : `项目进程已退出（${signal ?? `代码 ${code}`}），请查看输出；若端口被抢占，请重新运行。`,
            code !== 0,
          ),
        );
        this.publish({
          state: "starting",
          project,
          pid: child.pid,
          previewReady: false,
          message: `正在运行 ${project.packageManager} run ${project.script}…`,
          portMessage:
            port !== preferred
              ? `端口 ${preferred} 已被占用，已自动选择可用端口 ${port}。`
              : undefined,
        });
        void this.waitForPreview(entry).catch((error) => {
          if (this.live(entry))
            this.publish({
              ...this.status,
              state: "error",
              previewReady: false,
              message: String(error instanceof Error ? error.message : error),
            });
        });
        return this.status;
      } catch (error) {
        return this.publish({
          ...this.status,
          state: "error",
          previewReady: false,
          message: error instanceof Error ? error.message : "项目启动失败。",
        });
      }
    });
  }

  stop(): Promise<SiteStatus> {
    ++this.revision;
    if (this.entry) this.entry.cancelled = true;
    return this.exclusive(() => this.stopCurrent());
  }

  private async stopCurrent(): Promise<SiteStatus> {
    const entry = this.entry;
    if (entry) {
      entry.cancelled = true;
      this.publish({
        ...this.status,
        state: "stopping",
        previewReady: false,
        message: "正在停止项目…",
      });
      try {
        await stopSiteProcess(entry.child);
      } catch (error) {
        this.publish({
          ...this.status,
          state: "error",
          message:
            error instanceof Error ? error.message : "停止失败，请重试。",
        });
        throw error;
      }
      this.entry = null;
    }
    return this.publish({
      ...this.status,
      state: "stopped",
      pid: undefined,
      previewReady: false,
      message: "项目已停止。",
    });
  }

  private exited(entry: Entry, message: string, failed: boolean): void {
    if (this.entry !== entry || entry.cancelled) return;
    entry.cancelled = true;
    // The package manager may exit before a descendant: reap the owned group too.
    void this.exclusive(async () => {
      if (this.entry !== entry) return;
      await this.stopCurrent();
      this.publish({
        ...this.status,
        state: failed ? "error" : "stopped",
        message,
      });
    }).catch(() => {
      /* stopCurrent retains the process and publishes a retryable error. */
    });
  }

  private append(entry: Entry, chunk: string): void {
    entry.output = (entry.output + chunk).slice(-7000);
    if (this.entry === entry)
      this.publish({ ...this.status, output: entry.output });
  }

  private async verified(entry: Entry, url: string): Promise<boolean> {
    if (!this.live(entry)) return false;
    const target = localSiteUrl(url);
    const port = sitePort(target);
    if (
      !(await siteOwnsPort(entry.child.pid!, port, target.hostname)) ||
      !this.live(entry)
    )
      return false;
    if (!(await siteResponds(url)) || !this.live(entry)) return false;
    // Recheck after HTTP to guard against the server exiting/rebinding during fetch.
    return (
      (await siteOwnsPort(entry.child.pid!, port, target.hostname)) &&
      this.live(entry)
    );
  }

  private async waitForPreview(entry: Entry): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 45000);
    while (this.live(entry) && Date.now() < deadline) {
      const candidates = [
        ...new Set([
          entry.project.url,
          ...announcedSiteUrls(entry.output).reverse(),
        ]),
      ];
      for (const url of candidates) {
        if (!(await this.verified(entry, url))) continue;
        if (!this.live(entry)) return;
        const changed = url !== entry.project.url;
        const previous = entry.project.url;
        entry.project = { ...entry.project, url };
        this.publish({
          ...this.status,
          state: "running",
          project: entry.project,
          previewReady: true,
          message: "项目已启动，正在打开预览。",
          portMessage: changed
            ? [
                this.status.portMessage,
                `开发服务器实际地址为 ${url}（原地址 ${previous}）。`,
              ]
                .filter(Boolean)
                .join(" ")
            : this.status.portMessage,
        });
        await this.options.openPreview(url);
        if (this.live(entry))
          this.publish({
            ...this.status,
            message: "项目已启动，预览窗口已打开。",
          });
        return;
      }
      await delay(300);
    }
    if (this.live(entry))
      this.publish({
        ...this.status,
        state: "error",
        previewReady: false,
        message:
          "命令仍在运行，但未确认可用且属于本次进程的预览端口。请检查输出、监听地址及端口后停止重试；不会打开其他服务。端口归属检查需要系统进程查询工具。",
      });
  }

  async open(url: string): Promise<void> {
    const entry = this.entry;
    if (
      !entry ||
      !this.status.previewReady ||
      localSiteUrl(url).toString() !== entry.project.url ||
      !(await this.verified(entry, url))
    )
      throw new Error("预览尚未就绪或端口已不属于本次项目，请停止后重新运行。");
    await this.options.openPreview(url);
  }
}
