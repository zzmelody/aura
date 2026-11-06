import { serve, type ServerType } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

interface FetchApplication {
  fetch(request: Request): Response | Promise<Response>;
}

export interface HonoServerHandle {
  server: ServerType;
  port: number;
}

/** Starts a Hono Fetch application with the official Node.js adapter. */
export async function startHonoServer(
  app: FetchApplication,
  host: string,
  port: number,
): Promise<HonoServerHandle> {
  let server: ServerType | undefined;
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server = serve(
      { fetch: app.fetch.bind(app), hostname: host, port },
      (info) => resolve({ port: info.port }),
    );
    server.once("error", reject);
  });
  if (!server) throw new Error("Hono server adapter did not start.");
  return { server, port: address.port };
}

/** Gracefully stops a server returned by Hono's Node.js adapter. */
export async function closeHonoServer(server: ServerType): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

function allowsOrigin(origin: string, requestHostHeader: string | undefined) {
  try {
    const nativeAppOrigins = new Set([
      "capacitor://localhost",
      "https://localhost",
    ]);
    if (nativeAppOrigins.has(origin)) return true;
    const originHost = new URL(origin).hostname;
    const requestHost = new URL(`http://${requestHostHeader ?? "invalid"}`)
      .hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
    return (
      originHost === requestHost ||
      (loopback.has(originHost) && loopback.has(requestHost))
    );
  } catch {
    return false;
  }
}

const honoCors = cors({
  origin: (origin, context) =>
    allowsOrigin(origin, context.req.header("Host")) ? origin : null,
  allowHeaders: [
    "Content-Type",
    "Idempotency-Key",
    "Range",
    "If-Range",
    "If-None-Match",
    "Last-Event-ID",
  ],
  exposeHeaders: [
    "X-Aura-Error-Code",
    "Content-Length",
    "Content-Range",
    "Content-Disposition",
    "ETag",
    "Accept-Ranges",
  ],
  allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
});

/** Rejects foreign browser origins while admitting Aura's fixed Capacitor origin. */
export const localOriginPolicy: MiddlewareHandler = async (context, next) => {
  const origin = context.req.header("Origin");
  if (origin && !allowsOrigin(origin, context.req.header("Host")))
    return context.body(null, 403);
  return honoCors(context, next);
};

export function formatHttpUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
