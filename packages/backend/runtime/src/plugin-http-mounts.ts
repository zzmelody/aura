import { isPluginHttpMount } from "@aura/protocol/plugin-http";

/** Top-level namespaces routed by Aura's built-in HTTP API. */
export const reservedPluginHttpMounts = [
  "/ai",
  "/auth",
  "/chat",
  "/coding",
  "/flows",
  "/health",
  "/integrations",
  "/plugins",
  "/services",
];

export function isTopLevelPluginHttpRequest(path: string): boolean {
  const [, name] = path.split("/", 2);
  const mount = `/${name ?? ""}`;
  return isPluginHttpMount(mount) && !reservedPluginHttpMounts.includes(mount);
}
