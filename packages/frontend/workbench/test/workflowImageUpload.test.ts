import assert from "node:assert/strict";
import test from "node:test";
import { MessageError } from "@aura/i18n/runtime";
import {
  uploadWorkflowImage,
  WorkflowApiError,
} from "../src/workflowSessions.ts";

test("workflow image upload sends bytes and keeps only the returned asset ID", async () => {
  const id = "a".repeat(64);
  const file = new File([new Uint8Array([137, 80, 78, 71])], "frame.png");
  let called = false;
  const request: typeof fetch = async (input, init) => {
    called = true;
    assert.equal(input, "http://localhost:4311/flows/assets/images");
    assert.equal(init?.method, "POST");
    assert.equal(
      (init?.headers as Record<string, string>)["Content-Type"],
      "image/png",
    );
    assert.equal(init?.body, file);
    return Response.json({ assetId: id }, { status: 201 });
  };
  assert.equal(
    await uploadWorkflowImage(
      "http://localhost:4311/",
      file,
      undefined,
      request,
    ),
    id,
  );
  assert(called);
  await assert.rejects(
    uploadWorkflowImage(
      "http://localhost:4311",
      new File(["x"], "bad.txt"),
      undefined,
      request,
    ),
    (error: unknown) =>
      error instanceof MessageError &&
      typeof error.text !== "string" &&
      error.text.key === "uploadType",
  );
  await assert.rejects(
    uploadWorkflowImage("http://localhost:4311", file, undefined, async () =>
      Response.json({ message: "bad" }, { status: 400 }),
    ),
    (error: unknown) =>
      error instanceof WorkflowApiError && error.status === 400,
  );
});
