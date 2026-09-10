import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configureRuntimeNetwork,
  mergeNoProxy,
  parseWindowsProxyServer,
  type NetworkProxySettings,
} from "../src/network-proxy.ts";

test("Windows single-server proxy applies to HTTP and HTTPS", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7890"), {
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
  });
});

test("Windows protocol-specific proxy ignores unsupported protocols", () => {
  assert.deepEqual(
    parseWindowsProxyServer(
      "http=proxy.example:8080;https=https://secure.example:8443;socks=127.0.0.1:1080",
    ),
    {
      httpProxy: "http://proxy.example:8080",
      httpsProxy: "https://secure.example:8443",
    },
  );
});

test("no-proxy values are merged with loopback hosts", () => {
  assert.equal(
    mergeNoProxy("example.test;<local>", "localhost,internal.test"),
    "example.test,localhost,internal.test,127.0.0.1,[::1]",
  );
});

test("runtime adopts Windows system proxy when environment is empty", async () => {
  const env: NodeJS.ProcessEnv = {};
  let installed: NetworkProxySettings | undefined;
  const settings = await configureRuntimeNetwork({
    env,
    platform: "win32",
    readWindowsProxy: async () => ({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "intranet.test,localhost,127.0.0.1,[::1]",
    }),
    installDispatcher: (next) => {
      installed = next;
    },
  });

  assert.deepEqual(settings, installed);
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NO_PROXY, "intranet.test,localhost,127.0.0.1,[::1]");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("explicit proxy environment wins over Windows system settings", async () => {
  const env: NodeJS.ProcessEnv = {
    HTTPS_PROXY: "http://explicit.example:9000",
    NO_PROXY: "example.test",
  };
  let systemRead = false;
  const settings = await configureRuntimeNetwork({
    env,
    platform: "win32",
    readWindowsProxy: async () => {
      systemRead = true;
      return undefined;
    },
    installDispatcher: () => {},
  });

  assert.equal(systemRead, false);
  assert.deepEqual(settings, {
    httpProxy: undefined,
    httpsProxy: "http://explicit.example:9000",
    noProxy: "example.test,127.0.0.1,localhost,[::1]",
  });
});
