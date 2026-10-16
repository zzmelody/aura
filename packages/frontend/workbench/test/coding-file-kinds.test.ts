import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayPath,
  fileDir,
  fileKind,
  fileName,
  fullPath,
} from "../src/features/coding/fileKinds.ts";

test("paths inside the project are shown relative to it", () => {
  assert.equal(
    displayPath("/Users/me/proj/src/app.ts", "/Users/me/proj"),
    "src/app.ts",
  );
  assert.equal(
    displayPath("C:\\work\\proj\\src\\a.css", "C:\\work\\proj\\"),
    "src/a.css",
  );
  assert.equal(displayPath("src/app.ts", "/Users/me/proj"), "src/app.ts");
  assert.equal(displayPath("/etc/hosts", "/Users/me/proj"), "/etc/hosts");
});

test("file name and folder split on either separator", () => {
  assert.equal(fileName("src/features/a.tsx"), "a.tsx");
  assert.equal(fileDir("src/features/a.tsx"), "src/features");
  assert.equal(fileDir("a.tsx"), "");
  assert.equal(fileName("a\\b.ts"), "b.ts");
});

test("file kinds come from the extension or well-known names", () => {
  assert.equal(fileKind("src/App.TSX"), "code");
  assert.equal(fileKind("a.scss"), "style");
  assert.equal(fileKind("package.json"), "config");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("logo.png"), "image");
  assert.equal(fileKind("Dockerfile"), "shell");
  assert.equal(fileKind("pnpm-lock.lock"), "lock");
  assert.equal(fileKind(".gitignore"), "unknown");
  assert.equal(fileKind("LICENSE"), "unknown");
});

test("relative paths resolve against the project for copying", () => {
  assert.equal(fullPath("src/a.ts", "/p/"), "/p/src/a.ts");
  assert.equal(fullPath("/abs/a.ts", "/p"), "/abs/a.ts");
});
