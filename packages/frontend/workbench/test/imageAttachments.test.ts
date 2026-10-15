import assert from "node:assert/strict";
import test from "node:test";
import { pastedImages } from "../src/useImageAttachments.ts";

/** Minimal DataTransfer stand-in: Node has File but no DataTransfer. */
function clipboard(files: File[], items: File[] = []): DataTransfer {
  return {
    files,
    items: items.map((file) => ({ kind: "file", getAsFile: () => file })),
  } as unknown as DataTransfer;
}

test("pasted screenshots that only arrive as clipboard items are kept", () => {
  const shot = new File([new Uint8Array([1])], "image.png", {
    type: "image/png",
  });
  const files = pastedImages(clipboard([], [shot, shot]), 42);
  assert.deepEqual(
    files.map((file) => [file.name, file.type]),
    [
      ["粘贴的图片-42-1.png", "image/png"],
      ["粘贴的图片-42-2.png", "image/png"],
    ],
  );
});

test("named images pass through and non-images are dropped", () => {
  const photo = new File([new Uint8Array([1])], "photo.jpg", {
    type: "image/jpeg",
  });
  const text = new File(["hi"], "notes.txt", { type: "text/plain" });
  assert.deepEqual(pastedImages(clipboard([photo, text])), [photo]);
  assert.deepEqual(pastedImages(clipboard([], [text])), []);
});
