import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { fetch, type EnvHttpProxyAgent } from "undici";
import { configureDshNetwork } from "../src/dsh-network.ts";

test("DSH routes network requests through the runtime proxy", async () => {
  // A proxy's CONNECT handshake is below Hono's application HTTP boundary.
  const server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (!pending.includes("\r\n\r\n")) return;
      if (pending.startsWith("CONNECT ")) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        pending = "";
      } else {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nthrough-proxy",
        );
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    );
    server.once("error", reject);
  });
  let installed: EnvHttpProxyAgent | undefined;
  const result = configureDshNetwork(
    {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: "127.0.0.1,localhost,[::1]",
    },
    (agent) => {
      installed = agent;
    },
  );
  try {
    assert.equal(result, true);
    assert.ok(installed);
    const response = await fetch("http://unresolvable.invalid/test", {
      dispatcher: installed,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(await response.text(), "through-proxy");
  } finally {
    await installed?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("DSH leaves direct networking alone when no proxy is configured", () => {
  assert.equal(
    configureDshNetwork({}, () => {
      throw new Error("unexpected");
    }),
    false,
  );
});
