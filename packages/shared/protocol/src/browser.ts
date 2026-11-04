/** One approved guest: `lease` names it, `partition` is its workspace storage. */
export interface BrowserReservation {
  lease: string;
  partition: string;
}

/** The desktop bridge owns browser guests; the workbench owns their tabs. */
export interface BrowserHost {
  /** Workspaces share one in-memory storage partition until the app exits. */
  acquire(workspace: string): Promise<BrowserReservation>;
  release(lease: string): Promise<void>;
  navigate(lease: string, url: string): Promise<void>;
  openExternal(lease: string): Promise<void>;
}

export function httpPage(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const url = URL.parse(value);
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url
    : undefined;
}

/** An address bar defaults to HTTPS, except for local development servers. */
export function browserAddress(value: string): string | undefined {
  const address = value.trim();
  if (!address || /\s/u.test(address)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(address)) return httpPage(address)?.href;
  const url = httpPage(`https://${address}`);
  if (!url) return undefined;
  if (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
  )
    url.protocol = "http:";
  return url.href;
}
