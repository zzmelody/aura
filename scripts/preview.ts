/** Serves the exported web app, loopback-only unless HOST is explicitly set. */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

const root = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error("PORT must be an integer between 1 and 65535.");

const app = new Hono();
app.use("*", secureHeaders());
app.use("*", async (context, next) => {
  context.header("Cache-Control", "no-cache");
  await next();
});
app.get(
  "/*",
  serveStatic({
    root,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);
app.notFound((context) => context.text("Not found", 404));

serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`Aura preview: http://${host}:${port}`);
});
