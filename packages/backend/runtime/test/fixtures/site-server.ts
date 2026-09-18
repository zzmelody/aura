import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [port, mode = "normal", wait = "0"] = process.argv.slice(2);
await delay(Number(wait));
await writeFile("started.txt", "started");
if (mode === "idle") {
  setInterval(() => {}, 1000);
} else {
  const app = new Hono().get("*", (context) => context.text("owned site"));
  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: Number(port) },
    async (info) => {
      const url = `http://127.0.0.1:${info.port}/`;
      process.stdout.write("\u001b[32mLocal: http://127.");
      await delay(40);
      process.stdout.write(`0.0.1:${info.port}/\u001b[0m\n`);
      await writeFile("listening.txt", url);
    },
  );
  server.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
