import { httpPage } from "@aura/protocol/browser";

export function browserTarget(
  value: unknown,
  reservedPorts: ReadonlySet<string>,
): URL | undefined {
  const url = httpPage(value);
  return url && !reservedPorts.has(url.port) ? url : undefined;
}

const LEASE_PAGE = /^about:blank#([0-9a-f-]{36})$/u;

/** The lease named by a guest's inert first document, `about:blank#<lease>`. */
export function guestLease(value: unknown): string | undefined {
  return typeof value === "string" ? LEASE_PAGE.exec(value)?.[1] : undefined;
}

/** Deny app ports even through a hostname alias, redirect or WebSocket. */
export function blocksBrowserRequest(
  value: string,
  reservedPorts: ReadonlySet<string>,
): boolean {
  const url = URL.parse(value);
  return !url || url.protocol === "file:" || reservedPorts.has(url.port);
}
