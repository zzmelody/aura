/** A plugin owns a top-level namespace or a legacy Flow subnamespace. */
export function isPluginHttpMount(value: string): boolean {
  return value !== "/flows" && /^\/(?:flows\/)?[a-z][a-z0-9-]*$/u.test(value);
}

export function matchesPluginHttpMount(path: string, mount: string): boolean {
  return path === mount || path.startsWith(`${mount}/`);
}
