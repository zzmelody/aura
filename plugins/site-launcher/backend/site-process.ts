import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SiteProject } from "@aura/protocol/types";
import { siteDirectCommand, siteScriptArgs } from "./site-project.ts";

export function spawnSite(
  project: SiteProject,
  command: string,
  flags: string[],
): ChildProcess {
  const windows = process.platform === "win32";
  const direct = siteDirectCommand(command, flags);
  const localBin = join(project.directory, "node_modules", ".bin");
  const path = [localBin, process.env.PATH].filter(Boolean).join(delimiter);
  const env = { ...process.env, BROWSER: "none", PATH: path };
  // On Windows .cmd package-manager shims need cmd.exe. Every argument here is
  // either a validated script name or a fixed adapter flag/host/numeric port.
  if (direct) {
    return spawn(
      windows ? "cmd.exe" : direct.command,
      windows
        ? ["/d", "/s", "/c", [direct.command, ...direct.args].join(" ")]
        : direct.args,
      {
        cwd: project.directory,
        detached: !windows,
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  const args = siteScriptArgs(project, flags);
  return spawn(
    windows ? "cmd.exe" : project.packageManager,
    windows
      ? ["/d", "/s", "/c", [project.packageManager, ...args].join(" ")]
      : args,
    {
      cwd: project.directory,
      detached: !windows,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export async function stopSiteProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
      });
      killer.once("error", reject);
      killer.once("exit", (code) =>
        code === 0 || child.exitCode !== null || child.signalCode !== null
          ? resolve()
          : reject(new Error("无法结束项目进程，请重试停止。")),
      );
    });
    return;
  }
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  for (let i = 0; i < 40; i++) {
    if (!signalGroup(0)) return;
    await delay(50);
  }
  signalGroup("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (!signalGroup(0)) return;
    await delay(50);
  }
  throw new Error("项目进程尚未完全退出，请重试停止。");
}
