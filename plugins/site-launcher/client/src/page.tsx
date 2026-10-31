import React, { useMemo } from "react";
import {
  definePage,
  type AuraPluginPageProps,
  type Context,
} from "@aura/plugin-ui";
import {
  chooseSiteDirectory,
  openSitePreview,
  platform,
  siteDialogsAvailable,
} from "@aura/workbench/plugin";
import type { SiteProject, SiteStatus, JsonValue } from "@aura/protocol/types";
import { SiteScreen } from "./SiteScreen";
import { normalizeSiteProject, type SiteHostApi } from "./site";
import styles from "./site.css?inline";

function siteHost(call: AuraPluginPageProps["invoke"]): SiteHostApi {
  const invoke = (operation: string, input: JsonValue = {}) =>
    call(operation, input);
  const readProject = (value: unknown) => {
    const project = normalizeSiteProject(value);
    if (!project) throw new Error("站点配置无效。");
    return project;
  };
  const readStatus = (value: unknown): SiteStatus => {
    if (
      !value ||
      typeof value !== "object" ||
      !("state" in value) ||
      typeof value.state !== "string" ||
      !["idle", "starting", "running", "stopping", "stopped", "error"].includes(
        value.state,
      )
    )
      throw new Error("站点状态无效。");
    return value as SiteStatus;
  };
  const open = async (project: SiteProject) => {
    const verified = readProject(await invoke("open", { id: project.id }));
    await openSitePreview(verified.url, verified.id, verified.name);
  };
  return {
    async chooseDirectory() {
      const directory = await chooseSiteDirectory();
      return directory
        ? readProject(await invoke("describe", { directory }))
        : null;
    },
    async start(project) {
      return readStatus(await invoke("start", { ...project }));
    },
    async stop(id) {
      return readStatus(await invoke("stop", { id }));
    },
    open,
    onStatus(callback) {
      const abort = new AbortController();
      const opened = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        try {
          const source = await call("status", {}, abort.signal);
          if (!Array.isArray(source)) throw new Error("站点状态无效。");
          for (const value of source) {
            const status = readStatus(value);
            callback(status);
            if (status.project && status.previewReady && status.pid) {
              const key = `${status.project.id}:${status.pid}`;
              if (!opened.has(key)) {
                opened.add(key);
                await open(status.project).catch(() => opened.delete(key));
              }
            }
          }
        } catch {
          // A runtime restart is retried without losing the saved project list.
        } finally {
          if (!abort.signal.aborted)
            timer = setTimeout(() => void poll(), 1000);
        }
      };
      void poll();
      return () => {
        abort.abort();
        clearTimeout(timer);
      };
    },
  };
}

function SitePage(props: AuraPluginPageProps) {
  const host = useMemo(
    () =>
      platform() === "desktop" && siteDialogsAvailable()
        ? siteHost(props.invoke)
        : undefined,
    [props.invoke],
  );
  return <SiteScreen host={host} />;
}

export const inject = ["auraWorkbench"];
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.auraPlugin = "site-launcher";
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.auraWorkbench.page(
    definePage({
      id: "sites",
      title: "Site",
      icon: "PanelsTopLeft",
      render: (props) => <SitePage key={props.endpoint} {...props} />,
    }),
  );
}
