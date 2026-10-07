import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashContribution } from "../src/contribution-hash.ts";

// Existing directory tests could not detect changes in plugin-wide shared code.
test("plugin revision includes static imports and re-exports outside its contribution", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-dependency-hash-"));
  try {
    const directory = join(root, "flows", "wish");
    const lib = join(root, "lib");
    await mkdir(directory, { recursive: true });
    await mkdir(lib);
    await writeFile(
      join(directory, "wish.flow.js"),
      'import { value } from "../../lib/contracts.js"; export default value;',
    );
    await writeFile(
      join(lib, "contracts.js"),
      'export { value } from "./prompts.js";',
    );
    await writeFile(join(lib, "prompts.js"), 'export const value = "first";');
    const first = await hashContribution(directory, root);
    await writeFile(
      join(lib, "unrelated.js"),
      'export const other = "unrelated";',
    );
    assert.equal(await hashContribution(directory, root), first);
    await writeFile(join(lib, "prompts.js"), 'export const value = "second";');
    assert.notEqual(await hashContribution(directory, root), first);
    await writeFile(
      join(lib, "prompts.js"),
      'export { value } from "./contracts.js";',
    );
    assert.match(
      await hashContribution(directory, root),
      /^[a-f0-9]{64}$/u,
      "cycles terminate",
    );
    await writeFile(
      join(lib, "prompts.js"),
      'export { value } from "../../outside.js";',
    );
    await assert.rejects(hashContribution(directory, root));
    await writeFile(
      join(lib, "prompts.js"),
      'export const value = import("./" + "computed.js");',
    );
    await assert.rejects(
      hashContribution(directory, root),
      /literal module specifiers/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
