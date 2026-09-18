import { useEffect, useMemo, useState } from "react";
import { platform } from "./platform.ts";
import type { SiteProject, SiteStatus, SiteStatusState, SitePackageManager } from "@aura/protocol/types";
export type { SiteProject, SiteStatus, SiteStatusState, SitePackageManager } from "@aura/protocol/types";

export type SiteHostApi = {
  chooseDirectory(): Promise<SiteProject | null>;
  start(project: SiteProject): Promise<SiteStatus>;
  stop(id: string): Promise<SiteStatus>;
  open(project: SiteProject): Promise<void>;
  onStatus(callback: (status: SiteStatus) => void): () => void;
};

const STORAGE_KEY = "aura.sites.v2";
const LEGACY_STORAGE_KEY = "aura.site.v1";
const SELECTED_KEY = "aura.sites.selected.v1";
const packageManagers = new Set<SitePackageManager>(["pnpm", "npm", "yarn", "bun"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSiteProject(value: unknown): SiteProject | null {
  if (!isRecord(value)) return null;
  const scripts = Array.isArray(value.scripts)
    ? value.scripts.filter((item): item is string => typeof item === "string")
    : [];
  if (
    typeof value.directory !== "string" || !value.directory ||
    typeof value.name !== "string" ||
    !packageManagers.has(value.packageManager as SitePackageManager) ||
    typeof value.script !== "string" || typeof value.url !== "string" ||
    !scripts.includes(value.script)
  ) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : value.directory,
    directory: value.directory,
    name: value.name,
    packageManager: value.packageManager as SitePackageManager,
    scripts,
    script: value.script,
    url: value.url,
  };
}

export function normalizeSiteProjects(value: unknown): SiteProject[] {
  const values = Array.isArray(value) ? value : [value];
  const unique = new Map<string, SiteProject>();
  for (const item of values) {
    const project = normalizeSiteProject(item);
    if (project) unique.set(project.id, project);
  }
  return [...unique.values()];
}

function readProjects(): SiteProject[] {
  try {
    const current = globalThis.localStorage.getItem(STORAGE_KEY);
    if (current) return normalizeSiteProjects(JSON.parse(current));
    const legacy = globalThis.localStorage.getItem(LEGACY_STORAGE_KEY);
    return legacy ? normalizeSiteProjects(JSON.parse(legacy)) : [];
  } catch { return []; }
}

function saveProjects(projects: SiteProject[]): void {
  try { globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch { /* session only */ }
}

function readSelected(projects: SiteProject[]): string | null {
  try {
    const selected = globalThis.localStorage.getItem(SELECTED_KEY);
    return selected && projects.some((project) => project.id === selected) ? selected : projects[0]?.id ?? null;
  } catch { return projects[0]?.id ?? null; }
}

function saveSelected(id: string | null): void {
  try {
    if (id) globalThis.localStorage.setItem(SELECTED_KEY, id);
    else globalThis.localStorage.removeItem(SELECTED_KEY);
  } catch { /* selection is a convenience */ }
}

function hostApi(): SiteHostApi | undefined {
  return platform() === "desktop" ? globalThis.window?.auraHost?.site : undefined;
}

function isBusy(status: SiteStatus | undefined): boolean {
  return status?.state === "starting" || status?.state === "stopping";
}

export function useSiteProjects() {
  const [host] = useState<SiteHostApi | undefined>(() => hostApi());
  const [projects, setProjects] = useState<SiteProject[]>(() => readProjects());
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelected(readProjects()));
  const [statuses, setStatuses] = useState<Record<string, SiteStatus>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const selectedStatus = selected ? statuses[selected.id] ?? { state: "idle", project: selected } : { state: "idle" as SiteStatusState };

  useEffect(() => saveProjects(projects), [projects]);
  useEffect(() => {
    setSelectedId((current) => {
      const next = current && projects.some((project) => project.id === current) ? current : projects[0]?.id ?? null;
      if (next !== current) saveSelected(next);
      return next;
    });
  }, [projects]);
  useEffect(() => saveSelected(selectedId), [selectedId]);
  useEffect(() => {
    if (!host) return;
    return host.onStatus((status) => {
      if (!status.project) return;
      setStatuses((current) => ({ ...current, [status.project!.id]: status }));
      setProjects((current) => {
        const index = current.findIndex((project) => project.id === status.project!.id);
        if (index < 0) return [...current, status.project!];
        const next = current.slice(); next[index] = status.project!; return next;
      });
    });
  }, [host]);

  function setBusy(id: string, value: boolean) {
    setBusyIds((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; });
  }
  async function chooseDirectory() {
    if (!host) return;
    const next = await host.chooseDirectory();
    if (!next) return;
    setProjects((current) => {
      const index = current.findIndex((project) => project.id === next.id);
      if (index < 0) return [...current, next];
      const updated = current.slice(); updated[index] = { ...updated[index], ...next }; return updated;
    });
    setSelectedId(next.id);
  }
  function select(id: string) { if (projects.some((project) => project.id === id)) setSelectedId(id); }
  function updateProject(id: string, patch: Partial<SiteProject>) {
    if (busyIds.has(id) || isBusy(statuses[id])) return;
    setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch } : project));
  }
  async function run(id: string) {
    const project = projects.find((item) => item.id === id);
    if (!host || !project || busyIds.has(id) || statuses[id]?.pid) return;
    setBusy(id, true);
    setStatuses((current) => ({ ...current, [id]: { state: "starting", project, message: "正在启动项目…" } }));
    try {
      const next = await host.start(project);
      setStatuses((current) => ({ ...current, [id]: next }));
      if (next.project) setProjects((current) => current.map((item) => item.id === id ? next.project! : item));
    } catch (error) {
      setStatuses((current) => ({ ...current, [id]: { state: "error", project, message: error instanceof Error ? error.message : "项目启动失败。" } }));
    } finally { setBusy(id, false); }
  }
  async function stop(id: string) {
    if (!host || busyIds.has(id)) return;
    setBusy(id, true);
    try {
      const next = await host.stop(id); setStatuses((current) => ({ ...current, [id]: next }));
    } catch (error) {
      setStatuses((current) => ({ ...current, [id]: { ...current[id], state: "error", message: error instanceof Error ? error.message : "项目停止失败。" } }));
    } finally { setBusy(id, false); }
  }
  async function open(id: string) {
    const project = projects.find((item) => item.id === id);
    if (!host || !project || !statuses[id]?.previewReady || busyIds.has(id)) return;
    setBusy(id, true);
    try { await host.open(project); }
    catch (error) {
      setStatuses((current) => ({ ...current, [id]: { ...current[id], state: "error", previewReady: false, project, message: error instanceof Error ? error.message : "无法打开站点地址。" } }));
    } finally { setBusy(id, false); }
  }
  function remove(id: string) {
    if (busyIds.has(id) || statuses[id]?.pid || isBusy(statuses[id])) return;
    setProjects((current) => current.filter((project) => project.id !== id));
    setStatuses((current) => { const next = { ...current }; delete next[id]; return next; });
  }
  const runningCount = useMemo(() => Object.values(statuses).filter((status) => status.pid || status.state === "starting").length, [statuses]);
  return { available: Boolean(host), busyIds, projects, selected, selectedId: selected?.id ?? null, selectedStatus, statuses, runningCount, chooseDirectory, select, updateProject, run, stop, open, remove };
}

export const useSiteProject = useSiteProjects;
