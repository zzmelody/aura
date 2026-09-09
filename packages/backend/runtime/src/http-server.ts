import type { IncomingMessage, Server, ServerResponse } from "node:http";

export async function listenHttpServer(
  server: Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (!response.headersSent)
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
  if (!response.destroyed) response.end(JSON.stringify(body));
}

/** Allows native clients, loopback pages and same-host LAN development pages. */
export function allowRequestOrigin(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).hostname;
    const requestHost = new URL(`http://${request.headers.host ?? "invalid"}`)
      .hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
    if (
      originHost !== requestHost &&
      !(loopback.has(originHost) && loopback.has(requestHost))
    )
      return false;
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    return true;
  } catch {
    return false;
  }
}

export function formatHttpUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
