import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { transformWithOxc, type Plugin } from "vite";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const clientId = "/@aura/dev-reload.ts";
const virtualClientId = "\0aura:dev-reload.ts";

function inside(path: string, directory: string): boolean {
  const suffix = relative(directory, path);
  return (
    !isAbsolute(suffix) &&
    suffix !== ".." &&
    !suffix.startsWith("..\\") &&
    !suffix.startsWith("../")
  );
}

/** Development-only recovery for browser hosts that cannot keep Vite's socket open. */
export function liveReloadFallback(): Plugin {
  let session = randomUUID();
  let revision = 0;
  return {
    name: "aura-live-reload-fallback",
    apply: "serve" as const,
    configureServer(server) {
      session = randomUUID();
      revision = 0;
      const roots = [
        server.config.root,
        resolve(repoRoot, "packages/frontend"),
        resolve(repoRoot, "packages/shared"),
      ];
      const changed = (event: string, path: string) => {
        if (!["add", "change", "unlink"].includes(event)) return;
        if (
          /(?:^|[/\\])(?:node_modules|dist|\.aura|\.git)(?:[/\\]|$)/.test(path)
        )
          return;
        if (!/\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|json|svg)$/.test(path))
          return;
        if (roots.some((root) => inside(path, root))) revision += 1;
      };
      server.watcher.on("all", changed);
      server.httpServer?.once("close", () =>
        server.watcher.off("all", changed),
      );

      const api = new Hono();
      api.get("/@aura/dev-version", (context) => {
        context.header("Cache-Control", "no-store");
        return context.json({ session, revision });
      });
      // The official Hono adapter bridges Vite's Connect middleware boundary.
      const handler = getRequestListener(api.fetch, {
        overrideGlobalObjects: false,
      });
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] === "/@aura/dev-version")
          return handler(request, response);
        next();
      });
    },
    resolveId(id: string) {
      if (id === clientId) return virtualClientId;
    },
    async load(id: string) {
      if (id !== virtualClientId) return;
      const path = resolve(scriptsDir, "vite-live-reload-client.ts");
      return transformWithOxc(readFileSync(path, "utf8"), path);
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            name: "aura-dev-version",
            content: JSON.stringify({ session, revision }),
          },
          injectTo: "head" as const,
        },
        {
          tag: "script",
          attrs: { type: "module", src: clientId },
          injectTo: "head" as const,
        },
      ];
    },
  };
}
