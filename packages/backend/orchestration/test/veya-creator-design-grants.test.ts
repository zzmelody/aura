import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import test from "node:test";
import { commitCreatorBindingDocument, readCreatorBindingDocument, writeImmutableDesignFile } from "../src/veya-creator-design-grants.ts";
import { VeyaCreatorBindings } from "../src/veya-creator-bindings.ts";

const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const fixture = () => readFile(new URL("./fixtures/creator-design-bindings.json", import.meta.url));
const paths = (root: string) => ({ directory: join(root, ".aura", "veya-creator"), index: join(root, ".aura", "veya-creator", "bindings.json") });
async function setup(usePosixIdentity = process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "aura-design-grants-")), fixtureBytes = await fixture(), { directory, index } = paths(root);
  const original = JSON.parse(fixtureBytes.toString("utf8"));
  if (usePosixIdentity) for (const binding of Object.values(original.bindings) as any[]) {
    // The fixture records Windows host identity. Only adapt this test identity,
    // preserving its encoded byte length and the original recovery objects.
    const size = JSON.stringify(binding.sessionPath).length - 2;
    binding.sessionPath = "/" + sha(binding.sessionPath).slice(0, size - 1).padEnd(size - 1, "x");
  }
  const bytes = usePosixIdentity ? Buffer.from(JSON.stringify(original)) : fixtureBytes;
  await mkdir(directory, { recursive: true }); await writeFile(index, bytes);
  return { root, fixtureBytes, bytes, directory, index, original };
}
async function cleanup(root: string) {
  assert.equal(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"), true);
  await rm(root, { recursive: true, force: true });
}

test("prop recovery history keeps a bounded index, exact bytes and owner-bound immutable grants", async () => {
  const f = await setup();
  try {
    const identity = Object.values(f.original.bindings)[0] as any, sourceId = randomUUID(), sourceRunId = randomUUID();
    const source = {playerId:identity.playerId,homeWorldId:identity.homeWorldId,creationSessionId:identity.creationSessionId,
      sessionPath:identity.sessionPath,textHash:sha("make an axe"),kind:"prop",input:{operation:"create_prop",text:"make an axe"},runId:sourceRunId};
    const next = {version:1,bindings:{[sourceId]:source}} as any;
    for(let i=0;i<8;i++) next.bindings[randomUUID()] = {...source,runId:randomUUID(),input:{...source.input,previousRequestId:sourceId},
      recovery:{schemaVersion:1,noNewPaidWork:true,sourceRequestId:sourceId,sourceRunId,brief:{operation:"create_prop"},
        propSpec:{id:"axe"},assets:{metadata:"x".repeat(40000)},plan:{},generationScope:"original",repairRound:0,assetWorldId:"a".repeat(32)}};
    assert.ok(Buffer.byteLength(JSON.stringify(next))>256*1024);
    await commitCreatorBindingDocument(f.root,next);
    const bytes=await readFile(f.index), stored=JSON.parse(bytes.toString("utf8"));
    assert.ok(bytes.length<16*1024);
    assert.equal(Object.values(stored.bindings).filter((b:any)=>b.propRecoveryRef).length,8);
    assert.deepEqual(await readCreatorBindingDocument(f.root,bytes),next);
    await commitCreatorBindingDocument(f.root,await readCreatorBindingDocument(f.root,bytes));
    assert.deepEqual(await readFile(f.index),bytes);
    const key=Object.keys(stored.bindings).find(k=>stored.bindings[k].propRecoveryRef)!;
    const changed=structuredClone(stored); changed.bindings[key].playerId="another-player";
    await assert.rejects(readCreatorBindingDocument(f.root,Buffer.from(JSON.stringify(changed))),/creator_design_grant_invalid/);
    const ref=stored.bindings[key].propRecoveryRef, path=join(f.directory,"grants",ref.grantId+".json");
    await writeFile(path,"{}");
    await assert.rejects(readCreatorBindingDocument(f.root,bytes),/creator_design_grant_invalid/);
  } finally { await cleanup(f.root); }
});

test("the five actual legacy design grants migrate without changing bytes or raising the index limit", async () => {
  const f = await setup();
  try {
    assert.equal(f.fixtureBytes.length, 260967);
    assert.equal(sha(f.fixtureBytes), "ef0ad12aa878ee3f7dfff0e672e6c8fb4b2337a1a13ede04f435b928748408ce");
    assert.equal(f.bytes.length, f.fixtureBytes.length, "host path adaptation preserves the real index capacity boundary");
    const fixtureBindings = JSON.parse(f.fixtureBytes.toString("utf8")).bindings;
    for (const [key, binding] of Object.entries(f.original.bindings) as [string, any][]) if (binding.worldDesignRecovery)
      assert.equal(JSON.stringify(binding.worldDesignRecovery), JSON.stringify(fixtureBindings[key].worldDesignRecovery));
    assert.deepEqual(await readCreatorBindingDocument(f.root, f.bytes), f.original, "legacy reading is read-only and compatible");
    const next = structuredClone(f.original), source = next.bindings["91b48f29"] ?? Object.values(next.bindings).at(-1);
    next.bindings[randomUUID()] = structuredClone(source);
    assert.ok(Buffer.byteLength(JSON.stringify(next)) > 256 * 1024, "the real previous index cannot accommodate one more ordinary binding");
    await commitCreatorBindingDocument(f.root, next);
    const bytes = await readFile(f.index), stored = JSON.parse(bytes.toString("utf8"));
    assert.ok(bytes.length < 64 * 1024);
    assert.equal(Object.values(stored.bindings).filter((b: any) => b.worldDesignRecoveryRef).length, 5);
    assert.equal(Object.values(stored.bindings).some((b: any) => b.worldDesignRecovery), false);
    const expanded = await readCreatorBindingDocument(f.root, bytes);
    assert.deepEqual(expanded, next);
    for (const [key, binding] of Object.entries(f.original.bindings) as [string, any][]) if (binding.worldDesignRecovery)
      assert.equal(JSON.stringify(expanded.bindings[key]!.worldDesignRecovery), JSON.stringify(binding.worldDesignRecovery));
    const backups = await readdir(join(f.directory, "backups"));
    assert.deepEqual(backups, [`bindings-${sha(f.bytes)}.json`]);
    assert.deepEqual(await readFile(join(f.directory, "backups", backups[0]!)), f.bytes);
    await commitCreatorBindingDocument(f.root, expanded);
    assert.deepEqual(await readFile(f.index), bytes, "restart and commit preserve the exact reference identities");
    assert.equal((await readdir(join(f.directory, "backups"))).length, 1);
    const requestId = "113ad21e-1538-49e2-9c70-c00605097212", expected = expanded.bindings[requestId]!;
    const run = { id: expected.runId, requestId, flow: { id: "veya/veya-wish" } } as any;
    const bound = await new VeyaCreatorBindings(f.root).binding(run.id, () => run, false);
    assert.equal(JSON.stringify(bound?.record.worldDesignRecovery), JSON.stringify(expected.worldDesignRecovery), "the actual worker resolver hydrates the same bytes");
  } finally { await cleanup(f.root); }
});

test("legacy uppercase request and source UUIDs remain byte-exact through migration and restart", async () => {
  const f = await setup();
  try {
    const key = "113ad21e-1538-49e2-9c70-c00605097212", binding = structuredClone(f.original.bindings[key]);
    const sourceId = binding.input.previousRequestId, source = structuredClone(f.original.bindings[sourceId]);
    const requestId = key.toUpperCase(), sourceRequestId = sourceId.toUpperCase();
    source.runId = source.runId.toUpperCase(); binding.runId = binding.runId.toUpperCase();
    binding.input.previousRequestId = sourceRequestId;
    binding.worldDesignRecovery.sourceRequestId = sourceRequestId;
    binding.worldDesignRecovery.sourceRunId = source.runId;
    const original = { version: 1, bindings: { [sourceRequestId]: source, [requestId]: binding } };
    const bytes = Buffer.from(JSON.stringify(original)), originalGrant = JSON.stringify(binding.worldDesignRecovery);
    await writeFile(f.index, bytes);
    assert.deepEqual(await readCreatorBindingDocument(f.root, bytes), original);
    await commitCreatorBindingDocument(f.root, original);
    const stored = JSON.parse(await readFile(f.index, "utf8"));
    assert.deepEqual(Object.keys(stored.bindings), [sourceRequestId, requestId]);
    assert.equal(Object.hasOwn(stored.bindings, key), false, "the host must not normalize keys");
    const restored = await readCreatorBindingDocument(f.root, await readFile(f.index));
    assert.equal(JSON.stringify(restored.bindings[requestId]!.worldDesignRecovery), originalGrant);
    assert.deepEqual(restored, original);
    assert.deepEqual(await readFile(join(f.directory, "backups", `bindings-${sha(bytes)}.json`)), bytes);
  } finally { await cleanup(f.root); }
});

test("POSIX fixture host identities preserve capacity and the five original recovery byte hashes", async () => {
  const f = await setup(true);
  try {
    assert.equal(f.bytes.length, 260967);
    assert.equal(sha(f.bytes), "13670256ebc19b9aca07ee5e89b95e1287b58cf917ded4142c09c86a9d633b1f");
    const source = JSON.parse(f.fixtureBytes.toString("utf8")).bindings;
    for (const [key, binding] of Object.entries(f.original.bindings) as [string, any][]) {
      assert.ok(posix.isAbsolute(binding.sessionPath));
      if (binding.worldDesignRecovery)
        assert.equal(JSON.stringify(binding.worldDesignRecovery), JSON.stringify(source[key].worldDesignRecovery));
    }
    await commitCreatorBindingDocument(f.root, f.original);
    assert.deepEqual(await readCreatorBindingDocument(f.root, await readFile(f.index)), f.original);
    assert.deepEqual(await readFile(join(f.directory, "backups", `bindings-${sha(f.bytes)}.json`)), f.bytes);
  } finally { await cleanup(f.root); }
});

test("a partial immutable write cannot publish or poison its final hash path", async () => {
  const f = await setup();
  try {
    const content = Buffer.from('{"complete":"immutable grant"}'), path = join(f.directory, `${sha(content)}.json`);
    await assert.rejects(writeImmutableDesignFile(path, content, async (temporary, bytes) => {
      await writeFile(temporary, Buffer.from(bytes).subarray(0, 5), { flag: "wx" });
      throw Object.assign(new Error("injected_partial_write"), { code: "ENOSPC" });
    }), /injected_partial_write/u);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.deepEqual(await readFile(f.index), f.bytes);
    assert.equal((await readdir(f.directory)).some(name => name.endsWith(".tmp")), false);
    await Promise.all([writeImmutableDesignFile(path, content), writeImmutableDesignFile(path, content)]);
    assert.deepEqual(await readFile(path), content, "concurrent identical writes safely converge");
    await assert.rejects(writeImmutableDesignFile(path, "different bytes"), { code: "EEXIST" });
    assert.deepEqual(await readFile(path), content, "publication must never overwrite a conflicting immutable file");
    assert.equal((await readdir(f.directory)).some(name => name.endsWith(".tmp")), false);
  } finally { await cleanup(f.root); }
});

test("design references reject identity swaps, ambiguous inline data, missing files and tamper", async () => {
  const f = await setup();
  try {
    await commitCreatorBindingDocument(f.root, f.original);
    const stored = JSON.parse(await readFile(f.index, "utf8")), requestId = "113ad21e-1538-49e2-9c70-c00605097212";
    for (const mutate of [
      (d: any) => { d.bindings[requestId].worldDesignRecovery = f.original.bindings[requestId].worldDesignRecovery; },
      (d: any) => { d.bindings[requestId].worldDesignRecoveryRef.grantId = "../escape"; },
      (d: any) => { d.bindings[requestId].worldDesignRecoveryRef.extra = true; },
      (d: any) => { d.bindings[requestId].worldDesignRecoveryRef.contentHash = "0".repeat(64); },
      (d: any) => { d.bindings[requestId].worldDesignRecoveryRef = { grantId: "0".repeat(64), contentHash: "0".repeat(64) }; },
      ...["playerId", "homeWorldId", "creationSessionId", "sessionPath", "textHash"].map(key => (d: any) => {
        const b = d.bindings[requestId]; b[key] = d.bindings[b.input.previousRequestId][key] = key === "sessionPath" ? "C:/another/session.json" : "a".repeat(32);
      }),
      (d: any) => { const b = d.bindings[requestId]; d.bindings[b.input.previousRequestId].runId = randomUUID(); },
      (d: any) => { const b = d.bindings[requestId]; b.input.previousRequestId = randomUUID(); },
      (d: any) => { d.bindings[randomUUID()] = d.bindings[requestId]; delete d.bindings[requestId]; },
    ]) {
      const d = structuredClone(stored); mutate(d);
      await assert.rejects(readCreatorBindingDocument(f.root, Buffer.from(JSON.stringify(d))), /creator_design_grant_invalid/u);
    }
    const ref = stored.bindings[requestId].worldDesignRecoveryRef, path = join(f.directory, "grants", ref.grantId + ".json"), original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
    await assert.rejects(readCreatorBindingDocument(f.root, Buffer.from(JSON.stringify(stored))), /creator_design_grant_invalid/u);
    await writeFile(path, original);
    const forged = JSON.parse(original.toString("utf8")); forged.recovery.draftText += " ";
    const bytes = JSON.stringify(forged), hash = sha(bytes);
    await writeFile(join(f.directory, "grants", hash + ".json"), bytes);
    stored.bindings[requestId].worldDesignRecoveryRef = { grantId: hash, contentHash: hash };
    await assert.rejects(readCreatorBindingDocument(f.root, Buffer.from(JSON.stringify(stored))), /creator_design_grant_invalid/u, "readdressing cannot hide changed raw proof hashes");
    await assert.rejects(readCreatorBindingDocument(f.root, Buffer.alloc(256 * 1024 + 1)), /creator_design_grant_invalid/u);
  } finally { await cleanup(f.root); }
});

test("failed backup, immutable content or atomic rename leaves the old index and caller state unchanged", async () => {
  const f = await setup();
  try {
    const original = JSON.stringify(f.original);
    await writeFile(join(f.directory, "backups"), "obstruction");
    await assert.rejects(commitCreatorBindingDocument(f.root, f.original));
    assert.deepEqual(await readFile(f.index), f.bytes);
    await rm(join(f.directory, "backups"));
    await assert.rejects(commitCreatorBindingDocument(f.root, f.original, async () => { throw new Error("injected_rename_failure"); }), /injected_rename_failure/u);
    assert.deepEqual(await readFile(f.index), f.bytes);
    assert.equal(JSON.stringify(f.original), original);
    assert.equal((await readdir(f.directory)).some(name => name.endsWith(".tmp")), false);
    const files = await readdir(join(f.directory, "grants"));
    assert.equal(files.length, 5);
    const file = join(f.directory, "grants", files[0]!), bytes = await readFile(file);
    await writeFile(file, "tamper");
    await assert.rejects(commitCreatorBindingDocument(f.root, f.original));
    assert.deepEqual(await readFile(f.index), f.bytes);
    await writeFile(file, bytes);
    await commitCreatorBindingDocument(f.root, f.original);
    assert.deepEqual(await readCreatorBindingDocument(f.root, await readFile(f.index)), f.original);
  } finally { await cleanup(f.root); }
});

test("externalization does not increase individual recovery or index capacity", async () => {
  const f = await setup();
  try {
    const oversized = structuredClone(f.original), b = oversized.bindings["113ad21e-1538-49e2-9c70-c00605097212"];
    b.worldDesignRecovery.plan.padding = "x".repeat(240 * 1024);
    await assert.rejects(commitCreatorBindingDocument(f.root, oversized), /creator_design_grant_invalid/u);
    const noGrants = { version: 1, bindings: { [randomUUID()]: { padding: "x".repeat(256 * 1024) } } };
    await assert.rejects(commitCreatorBindingDocument(f.root, noGrants), /creator_capacity_exceeded/u);
    assert.deepEqual(await readFile(f.index), f.bytes);
  } finally { await cleanup(f.root); }
});
