import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCodexAuthorization } from "@aura/dsh-codex";

test("DSH registers an openai-codex authorization flow without network access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-dsh-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorization = await DshCodexAuthorization.create({
    credentialPath: join(root, ".credentials.yaml"),
  });
  t.after(() => authorization.close());
  assert.deepEqual(await authorization.status(), {
    state: "signed_out",
    model: "gpt-5.6-terra",
  });
});
