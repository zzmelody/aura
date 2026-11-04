import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_QUOTE_LENGTH,
  selectionQuote,
} from "../src/features/coding/selection-quote.ts";

test("selected text becomes a Markdown quote followed by a blank line", () => {
  assert.equal(
    selectionQuote("  hello\r\n\r\nworld \n"),
    "> hello\n>\n> world\n\n",
  );
});

test("blank selections produce no quote", () => {
  assert.equal(selectionQuote(" \n\t "), "");
});

test("long selections are truncated", () => {
  const quote = selectionQuote("a".repeat(MAX_QUOTE_LENGTH + 10));
  assert.equal(quote, `> ${"a".repeat(MAX_QUOTE_LENGTH)}…\n\n`);
});
