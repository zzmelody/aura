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
import {
  SiteStatusError,
  type SiteMessage,
} from "../shared/status-messages.ts";

export { describeProject } from "./site-project.ts";
export type { SiteProject, SiteStatus } from "@aura/protocol/types";

type Entry = {
  child: ChildProcess;
  project: SiteProject;
  output: string;
  cancelled: boolean;
  reservedPort?: number;
};
type Options = {
  onStatus(status: SiteStatus): void;
  openPreview(url: string, project?: SiteProject): Promise<void>;
  readinessTimeoutMs?: number;
};

/** Owns one process tree per configured site. The IPC host only forwards calls. */
export class SiteRunner {
  private readonly entries = new Map<string, Entry>();
  private readonly statuses = new Map<string, SiteStatus>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private readonly reservedPorts = new Map<number, string>();
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  getStatus(id?: string): SiteStatus {
    if (id) return this.statuses.get(id) ?? { state: "idle" };
    if (this.statuses.size === 1) return [...this.statuses.values()][0]!;
    return { state: "idle" };
  }

  getStatuses(): SiteStatus[] {
    return [...this.statuses.values()];
  }

  private publish(id: string, status: SiteStatus): SiteStatus {
    this.statuses.set(id, status);
    this.options.onStatus(status);
    return status;
  }

  private exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation);
    this.queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  private revision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }

  private bumpRevision(id: string): number {
    const next = this.revision(id) + 1;
    this.revisions.set(id, next);
    return next;
  }

  private live(id: string, entry: Entry): boolean {
    return (
      this.entries.get(id) === entry &&
      !entry.cancelled &&
      Boolean(entry.child.pid) &&
      entry.child.exitCode === null &&
      entry.child.signalCode === null
    );
  }

  private releasePort(entry: Entry): void {
    if (
      entry.reservedPort !== undefined &&
      this.reservedPorts.get(entry.reservedPort) === entry.project.id
    )
      this.reservedPorts.delete(entry.reservedPort);
    entry.reservedPort = undefined;
  }

  private async reservePort(preferred: number, id: string): Promise<number> {
    for (
      let port = preferred;
      port <= 65535 && port < preferred + 100;
      port++
    ) {
      if (this.reservedPorts.has(port)) continue;
      if (!(await portAvailable(port))) continue;
      this.reservedPorts.set(port, id);
      return port;
    }
    return availableSitePort(preferred);
  }

  start(input: unknown): Promise<SiteStatus> {
    const directory =
      typeof input === "object" && input !== null && "directory" in input
        ? String((input as { directory: unknown }).directory)
        : "pending-site";
    const revision = this.bumpRevision(directory);
    return this.exclusive(directory, async () => {
      let project: SiteProject | undefined;
      let entry: Entry | undefined;
      let reservedPort: number | undefined;
      try {
        if (revision !== this.revision(directory))
          return this.getStatus(directory);
        const { project: described, command } = await siteProjectInput(input);
        project = described;
        const id = project.id;
        if (this.revision(id) < revision) this.revisions.set(id, revision);
        await this.stopCurrent(id);
        if (revision !== this.revision(id)) return this.getStatus(id);
        this.publish(id, {
          state: "starting",
          project,
          previewReady: false,
          message: "正在检查项目端口…",
          messageDetails: { code: "checkingPorts" },
        });
        const url = localSiteUrl(project.url);
        const preferred = sitePort(url);
        const hostname = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
        const supported = sitePortFlags(command, preferred, hostname) !== null;
        if (
          !supported &&
          (this.reservedPorts.has(preferred) ||
            !(await portAvailable(preferred)))
        )
          throw new SiteStatusError(
            `端口 ${preferred} 已被占用。自定义启动脚本无法安全自动改端口，请同时修改脚本监听端口和预览地址，或自行停止占用服务后重试。Aura 不会结束其他服务。`,
            { code: "portOccupied", params: { port: preferred } },
          );
        const port = supported
          ? await this.reservePort(preferred, id)
          : preferred;
        reservedPort = port;
        if (!supported) this.reservedPorts.set(port, id);
        const flags = supported
          ? (sitePortFlags(command, port, hostname) ?? [])
          : [];
        if (revision !== this.revision(id)) {
          this.reservedPorts.delete(port);
          return this.getStatus(id);
        }
        url.port = String(port);
        project = { ...project, url: url.toString() };
        const runProject = project;
        const child = spawnSite(runProject, command, flags);
        entry = {
          child,
          project: runProject,
          output: "",
          cancelled: false,
          reservedPort: port,
        };
        this.entries.set(id, entry);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) =>
          this.append(id, entry!, String(chunk)),
        );
        child.stderr?.on("data", (chunk) =>
          this.append(id, entry!, String(chunk)),
        );
        child.once("error", (error) =>
          this.exited(id, entry!, `无法启动项目：${error.message}`, true, {
            code: "startFailed",
          }),
        );
        child.once("exit", (code, signal) =>
          this.exited(
            id,
            entry!,
            code === 0
              ? "项目进程已结束。"
              : `项目进程已退出（${signal ?? `代码 ${code}`}），请查看输出；若端口被抢占，请重新运行。`,
            code !== 0,
            code === 0
              ? { code: "processEnded" }
              : signal
                ? { code: "processExitSignal", params: { signal } }
                : code !== null
                  ? { code: "processExitCode", params: { exitCode: code } }
                  : { code: "processExited" },
          ),
        );
        this.publish(id, {
          state: "starting",
          project: runProject,
          pid: child.pid,
          previewReady: false,
          message: `正在运行 ${runProject.packageManager} run ${runProject.script}…`,
          messageDetails: {
            code: "runningScript",
            params: {
              manager: runProject.packageManager,
              script: runProject.script,
            },
          },
          portMessage:
            port !== preferred
              ? `端口 ${preferred} 已被占用，已自动选择可用端口 ${port}。`
              : undefined,
          portDetails:
            port !== preferred
              ? [{ code: "portChanged", params: { preferred, port } }]
              : [],
        });
        const runEntry = entry;
        void this.waitForPreview(id, runEntry).catch((error) => {
          if (this.live(id, runEntry))
            this.publish(id, {
              ...this.getStatus(id),
              state: "error",
              previewReady: false,
              message: String(error instanceof Error ? error.message : error),
              messageDetails: { code: "previewFailed" },
            });
        });
        return this.getStatus(id);
      } catch (error) {
        if (entry) this.releasePort(entry);
        else if (reservedPort !== undefined)
          this.reservedPorts.delete(reservedPort);
        return this.publish(directory, {
          ...this.getStatus(directory),
          state: "error",
          project,
          previewReady: false,
          message: error instanceof Error ? error.message : "项目启动失败。",
          messageDetails:
            error instanceof SiteStatusError
              ? error.details
              : { code: "startFailed" },
        });
      }
    });
  }

  stop(id?: string): Promise<SiteStatus | SiteStatus[]> {
    if (id) {
      this.bumpRevision(id);
      const entry = this.entries.get(id);
      if (entry) entry.cancelled = true;
      return this.exclusive(id, () => this.stopCurrent(id));
    }
    const ids = new Set([...this.statuses.keys(), ...this.entries.keys()]);
    for (const siteId of ids) this.bumpRevision(siteId);
    return Promise.all(
      [...ids].map((siteId) =>
        this.exclusive(siteId, () => this.stopCurrent(siteId)),
      ),
    );
  }

  private async stopCurrent(id: string): Promise<SiteStatus> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.cancelled = true;
      this.publish(id, {
        ...this.getStatus(id),
        state: "stopping",
        previewReady: false,
        message: "正在停止项目…",
        messageDetails: { code: "stoppingProject" },
      });
      try {
        await stopSiteProcess(entry.child);
      } catch (error) {
        this.publish(id, {
          ...this.getStatus(id),
          state: "error",
          message:
            error instanceof Error ? error.message : "停止失败，请重试。",
          messageDetails: { code: "stopFailed" },
        });
        throw error;
      }
      this.entries.delete(id);
      this.releasePort(entry);
    }
    return this.publish(id, {
      ...this.getStatus(id),
      state: "stopped",
      pid: undefined,
      previewReady: false,
      message: "项目已停止。",
      messageDetails: { code: "projectStopped" },
    });
  }

  private exited(
    id: string,
    entry: Entry,
    message: string,
    failed: boolean,
    messageDetails: SiteMessage,
  ): void {
    // An exit event sets exitCode before this callback runs. live() would
    // reject the exited child and leave the site stuck in "starting".
    if (this.entries.get(id) !== entry || entry.cancelled) return;
    entry.cancelled = true;
    void this.exclusive(id, async () => {
      if (this.entries.get(id) !== entry) return;
      await this.stopCurrent(id);
      this.publish(id, {
        ...this.getStatus(id),
        state: failed ? "error" : "stopped",
        message,
        messageDetails,
      });
    }).catch(() => {
      /* stopCurrent retains the process and publishes a retryable error. */
    });
  }

  private append(id: string, entry: Entry, chunk: string): void {
    entry.output = (entry.output + chunk).slice(-7000);
    if (this.entries.get(id) === entry)
      this.publish(id, { ...this.getStatus(id), output: entry.output });
  }

  private async verified(
    id: string,
    entry: Entry,
    url: string,
  ): Promise<boolean> {
    if (!this.live(id, entry)) return false;
    const target = localSiteUrl(url);
    const port = sitePort(target);
    if (
      !(await siteOwnsPort(entry.child.pid!, port, target.hostname)) ||
      !this.live(id, entry)
    )
      return false;
    if (!(await siteResponds(url)) || !this.live(id, entry)) return false;
    return (
      (await siteOwnsPort(entry.child.pid!, port, target.hostname)) &&
      this.live(id, entry)
    );
  }

  private async waitForPreview(id: string, entry: Entry): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 45000);
    while (this.live(id, entry) && Date.now() < deadline) {
      const candidates = [
        ...new Set([
          entry.project.url,
          ...announcedSiteUrls(entry.output).reverse(),
        ]),
      ];
      for (const url of candidates) {
        if (!(await this.verified(id, entry, url))) continue;
        if (!this.live(id, entry)) return;
        const changed = url !== entry.project.url;
        const previous = entry.project.url;
        entry.project = { ...entry.project, url };
        this.publish(id, {
          ...this.getStatus(id),
          state: "running",
          project: entry.project,
          previewReady: true,
          message: "项目已启动，正在打开预览。",
          messageDetails: { code: "openingPreview" },
          portMessage: changed
            ? [
                this.getStatus(id).portMessage,
                `开发服务器实际地址为 ${url}（原地址 ${previous}）。`,
              ]
                .filter(Boolean)
                .join(" ")
            : this.getStatus(id).portMessage,
          portDetails: changed
            ? [
                ...(this.getStatus(id).portDetails ?? []),
                { code: "addressChanged", params: { url, previous } },
              ]
            : this.getStatus(id).portDetails,
        });
        await this.options.openPreview(entry.project.url, entry.project);
        if (this.live(id, entry))
          this.publish(id, {
            ...this.getStatus(id),
            message: "项目已启动，预览窗口已打开。",
            messageDetails: { code: "previewOpened" },
          });
        return;
      }
      await delay(300);
    }
    if (this.live(id, entry))
      this.publish(id, {
        ...this.getStatus(id),
        state: "error",
        previewReady: false,
        message:
          "命令仍在运行，但未确认可用且属于本次进程的预览端口。请检查输出、监听地址及端口后停止重试；不会打开其他服务。端口归属检查需要系统进程查询工具。",
        messageDetails: { code: "previewTimeout" },
      });
  }

  async open(projectOrUrl: SiteProject | string): Promise<void> {
    const entry =
      typeof projectOrUrl === "string"
        ? [...this.entries.values()].find(
            (candidate) => candidate.project.url === projectOrUrl,
          )
        : this.entries.get(projectOrUrl.id);
    const project = entry?.project;
    if (
      !entry ||
      !project ||
      !this.getStatus(project.id).previewReady ||
      (typeof projectOrUrl === "object" && projectOrUrl.url !== project.url) ||
      !(await this.verified(project.id, entry, project.url))
    )
      throw new SiteStatusError(
        "预览尚未就绪或端口已不属于本次项目，请停止后重新运行。",
        { code: "previewNotReady" },
      );
    await this.options.openPreview(project.url, project);
  }
}
