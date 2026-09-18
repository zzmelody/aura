import { useEffect, useRef, useState } from "react";
import { platform } from "./platform.ts";
import type {
  SiteProject,
  SiteStatus,
  SitePackageManager,
} from "@aura/protocol/types";
export type {
  SiteProject,
  SiteStatus,
  SiteStatusState,
  SitePackageManager,
} from "@aura/protocol/types";

export type SiteHostApi = {
  chooseDirectory(): Promise<SiteProject | null>;
  start(project: SiteProject): Promise<SiteStatus>;
  stop(): Promise<SiteStatus>;
  open(url: string): Promise<void>;
  onStatus(callback: (status: SiteStatus) => void): () => void;
};

const STORAGE_KEY = "aura.site.v1";
const packageManagers = new Set<SitePackageManager>([
  "pnpm",
  "npm",
  "yarn",
  "bun",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSiteProject(value: unknown): SiteProject | null {
  if (!isRecord(value)) return null;
  const scripts = Array.isArray(value.scripts)
    ? value.scripts.filter((item): item is string => typeof item === "string")
    : [];
  if (
    typeof value.directory !== "string" ||
    typeof value.name !== "string" ||
    !packageManagers.has(value.packageManager as SitePackageManager) ||
    typeof value.script !== "string" ||
    typeof value.url !== "string" ||
    !scripts.includes(value.script)
  )
    return null;
  return {
    directory: value.directory,
    name: value.name,
    packageManager: value.packageManager as SitePackageManager,
    scripts,
    script: value.script,
    url: value.url,
  };
}

function readProject(): SiteProject | null {
  try {
    return normalizeSiteProject(
      JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return null;
  }
}

function saveProject(project: SiteProject | null): void {
  try {
    if (project)
      globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    else globalThis.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The selected directory remains usable for this session if storage is unavailable.
  }
}

function hostApi(): SiteHostApi | undefined {
  return platform() === "desktop"
    ? globalThis.window?.auraHost?.site
    : undefined;
}

export function useSiteProject() {
  const [host] = useState<SiteHostApi | undefined>(() => hostApi());
  const [project, setProject] = useState<SiteProject | null>(() =>
    readProject(),
  );
  const [status, setStatus] = useState<SiteStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const statusVersion = useRef(0);

  useEffect(() => {
    saveProject(project);
  }, [project]);

  useEffect(() => {
    if (!host) return;
    return host.onStatus((next) => {
      statusVersion.current++;
      setStatus(next);
      if (next.project) setProject(next.project);
    });
  }, [host]);

  async function chooseDirectory() {
    if (!host || status.pid || busy) return;
    setBusy(true);
    try {
      const next = await host.chooseDirectory();
      if (next) {
        setProject(next);
        setStatus({
          state: "idle",
          project: next,
          message: "已选择项目目录。",
        });
      }
    } catch (error) {
      setStatus({
        state: "error",
        message:
          error instanceof Error ? error.message : "无法读取这个项目目录。",
      });
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!host || !project || status.pid || busy) return;
    setBusy(true);
    const version = statusVersion.current;
    setStatus({ state: "starting", project, message: "正在启动项目…" });
    try {
      const next = await host.start(project);
      if (version === statusVersion.current) setStatus(next);
    } catch (error) {
      setStatus({
        state: "error",
        project,
        message: error instanceof Error ? error.message : "项目启动失败。",
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!host) return;
    setBusy(true);
    const version = statusVersion.current;
    try {
      const next = await host.stop();
      if (version === statusVersion.current) setStatus(next);
    } catch (error) {
      setStatus((current) => ({
        ...current,
        state: "error",
        project: project ?? undefined,
        message: error instanceof Error ? error.message : "项目停止失败。",
      }));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!host || !project || !status.previewReady) return;
    setBusy(true);
    try {
      await host.open(project.url);
    } catch (error) {
      setStatus((current) => ({
        ...current,
        state: "error",
        previewReady: false,
        project,
        message: error instanceof Error ? error.message : "无法打开站点地址。",
      }));
    } finally {
      setBusy(false);
    }
  }

  function updateProject(patch: Partial<SiteProject>) {
    if (status.pid || busy) return;
    setProject((current) => (current ? { ...current, ...patch } : current));
  }

  return {
    available: Boolean(host),
    busy,
    project,
    status,
    chooseDirectory,
    updateProject,
    run,
    stop,
    open,
  };
}
