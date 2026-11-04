import assert from "node:assert/strict";
import test from "node:test";
import { browserAddress } from "@aura/protocol/browser";
import {
  blocksBrowserRequest,
  browserTarget,
  guestLease,
} from "../apps/desktop/src/browser-policy.ts";

test("guests bind only through an inert about:blank page naming a lease", () => {
  const lease = "6f1c2c1e-6a4b-4a39-9f43-2a0c1b7d9e10";
  assert.equal(guestLease(`about:blank#${lease}`), lease);
  for (const value of [
    "about:blank",
    `about:blank#${lease}x`,
    `https://example.com/#${lease}`,
    `about:blank#../${lease}`,
    undefined,
  ])
    assert.equal(guestLease(value), undefined);
});

test("browser addresses accept HTTPS and local preview servers without credentials", () => {
  assert.equal(browserAddress("example.com/docs"), "https://example.com/docs");
  assert.equal(browserAddress("localhost:5173"), "http://localhost:5173/");
  assert.equal(browserAddress("127.example.com"), "https://127.example.com/");
  assert.equal(browserAddress("[::1]:3000/page"), "http://[::1]:3000/page");
  assert.equal(browserAddress("file:///etc/passwd"), undefined);
  assert.equal(browserAddress("javascript:alert(1)"), undefined);
  assert.equal(browserAddress("https://name:password@example.com"), undefined);
});

test("the guest cannot reach Aura service ports through aliases or subresource requests", () => {
  const reserved = new Set(["4311", "8082"]);
  assert.equal(browserTarget("http://localhost:5173", reserved)?.port, "5173");
  for (const url of [
    "http://[::1]:4311/health",
    "http://localhost.:8082",
    "https://alias.example:4311/",
    "file:///private/page.html",
  ]) {
    assert.equal(browserTarget(url, reserved), undefined);
    assert.equal(blocksBrowserRequest(url, reserved), true);
  }
  assert.equal(
    blocksBrowserRequest("ws://alias.example:4311/", reserved),
    true,
  );
  assert.equal(
    blocksBrowserRequest("https://example.com/site.css", reserved),
    false,
  );
});
