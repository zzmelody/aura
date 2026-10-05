import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitVeyaCraft, assertCraftToolScope, craftToolScope, readVeyaCraftScope } from "../src/veya-gameplay-craft.ts";
import { VeyaCreatorBindings } from "../src/veya-creator-bindings.ts";
import { VeyaWorldAgentCapability, VEYA_WORLD_AGENT_CAPABILITY } from "../src/veya-world-agent.ts";
import type { FlowRun } from "@aura/protocol/types";

test("craft admission requires the native order, stable scope and a runtime descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "veya-craft-contract-")), path = join(root, "runtime.json");
  const scope = readVeyaCraftScope({ schemaVersion: 1, worldId: "qingchuan", instanceId: "instance.1", runtimeEpoch: 3, orderId: "craft.player.1" });
  const request = (async (_url: unknown, options: RequestInit) => {
    assert.equal(options.headers && new Headers(options.headers).get("authorization"), `Bearer ${"a".repeat(64)}`);
    assert.deepEqual(JSON.parse(String(options.body)).arguments, craftToolScope(scope));
    return new Response(JSON.stringify({ ok: true, data: { ...craftToolScope(scope), phase: "queued", authorization_digest: "b".repeat(64) } }));
  }) as typeof fetch;
  try {
    await writeFile(path, JSON.stringify({ role: "game-runtime", protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49111/", token: "a".repeat(64), tools_protocol: "veya-agent-tools/1" }));
    assert.equal(await admitVeyaCraft(path, scope, request), "b".repeat(64));
    for (const phase of ["completed", "cancelled", "ready_to_assemble"]) await assert.rejects(admitVeyaCraft(path, scope,
      (async () => new Response(JSON.stringify({ ok: true, data: { ...craftToolScope(scope), phase, authorization_digest: "b".repeat(64) } }))) as typeof fetch), /craft_order_stale/u);
    await assert.rejects(admitVeyaCraft(path, scope, (async () => new Response(JSON.stringify({ ok: true, data: { ...craftToolScope(scope), instance_id: "old", phase: "queued" } }))) as typeof fetch), /craft_scope_mismatch/u);
    for (const value of [{ ...scope, worldId: 1 }, { ...scope, runtimeEpoch: -1 }, { ...scope, orderId: "../outside" }, { ...scope, component: "inventory" }]) assert.throws(() => readVeyaCraftScope(value));
    assert.throws(() => assertCraftToolScope(scope, { ...craftToolScope(scope), order_id: "someone_else" }));
    await writeFile(path, JSON.stringify({ role: "creator-worker", protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49111/", token: "a".repeat(64) }));
    await assert.rejects(admitVeyaCraft(path, scope, request), /craft_foreground_invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a resumed craft Run translates only its authorized order into the new runtime instance", async () => {
  const root=await mkdtemp(join(tmpdir(),"veya-craft-resume-"));
  const original=readVeyaCraftScope({schemaVersion:1,worldId:"qingchuan",instanceId:"instance.old",runtimeEpoch:3,orderId:"craft.player.1"});
  const current={...original,instanceId:"instance.new",runtimeEpoch:8};
  const requestId=randomUUID(),runId=randomUUID(),worker=join(root,"worker.json"),foreground=join(root,"runtime.json");
  const run={id:runId,requestId,flow:{id:"veya/veya-gameplay-craft"},input:original} as unknown as FlowRun;
  try {
    await mkdir(join(root,".aura","veya-creator"),{recursive:true});
    await writeFile(worker,JSON.stringify({role:"creator-worker",creation_session_id:"c".repeat(32),protocol:"veya-world-http/1",base_url:"http://127.0.0.1:49222/",token:"b".repeat(64)}));
    await writeFile(foreground,JSON.stringify({role:"game-runtime",protocol:"veya-world-http/1",base_url:"http://127.0.0.1:49111/",token:"a".repeat(64),tools_protocol:"veya-agent-tools/1"}));
    await writeFile(join(root,".aura","veya-creator","bindings.json"),JSON.stringify({version:1,bindings:{[requestId]:{
      sessionPath:worker,creationSessionId:"c".repeat(32),runId,foregroundSessionPath:foreground,
      craftOriginalAuthorization:original,craftAuthorization:current,
    }}}));
    const binding=new VeyaCreatorBindings(root);let calls=0;
    const capability=new VeyaWorldAgentCapability(foreground,(async (url:unknown,options:RequestInit)=>{
      ++calls;assert.equal(String(url),"http://127.0.0.1:49111/agent/v1/call");
      const body=JSON.parse(String(options.body));assert.equal(body.tool,"veya.craft.context");assert.deepEqual(body.arguments,craftToolScope(current));
      return new Response(JSON.stringify({ok:true,data:{...craftToolScope(current),phase:"producing",authorization_digest:"d".repeat(64)}}));
    }) as typeof fetch);
    capability.setRunSessionResolver((id,operation,input)=>binding.resolve(id,()=>run,operation,input));
    const signal=new AbortController().signal;
    const result=await capability.invoke(VEYA_WORLD_AGENT_CAPABILITY,"veya.craft.context",craftToolScope(original),signal,{runId});
    assertCraftToolScope(original,result);assert.equal(calls,1);
    for(const invalid of [{...craftToolScope(original),order_id:"craft.someone.1"},{...craftToolScope(original),world_id:"another_world"},craftToolScope(current)])
      await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY,"veya.craft.context",invalid,signal,{runId}),/craft_scope_mismatch/u);
    assert.equal(calls,1,"invalid inputs never reach native tools");
    const ordinary={...run,flow:{id:"veya/veya-wish"}} as unknown as FlowRun;
    await assert.rejects(binding.resolve(runId,()=>ordinary,"veya.craft.context",craftToolScope(original)),/craft_authority_unavailable/u);
  } finally {await rm(root,{recursive:true,force:true});}
});
