import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
import {VeyaAvatarCapability,avatarDecisionFlow,avatarTools,writeAvatarBindings} from "../src/veya-avatar-bindings.ts";
import {VEYA_WORLD_AGENT_CAPABILITY} from "../src/veya-world-agent.ts";

test("Avatar capability binds the original foreground Run and only four native tools",async()=>{
 const root=await mkdtemp(join(tmpdir(),"aura-avatar-binding-")),path=join(root,"session.json");const previous=globalThis.fetch;
 try {
  const descriptor=JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",token:"a".repeat(64),pid:42});
  await writeFile(path,descriptor);
  const request={decisionId:"decision_1",worldId:"world",instanceId:"foreground",worldRevision:3,runtimeEpoch:7};
  await writeAvatarBindings(root,{version:1,bindings:{key:{key:"key",requestId:"request",sessionPath:path,sessionHash:createHash("sha256").update(descriptor).digest("hex"),request,runId:"run",state:"running"}}});
  let run={id:"run",requestId:"request",flow:{id:avatarDecisionFlow}} as FlowRun;let epoch=7;const calls:string[]=[];
  globalThis.fetch=(async(url,init)=>{
   calls.push(String(url));assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer "+"a".repeat(64));
   const tool=JSON.parse(String(init?.body??"{}")).tool;
   return Response.json({ok:true,data:tool==="veya.world.status"?{world_id:"world",instance_id:"foreground",revision:3,runtime_epoch:epoch}:{decision_id:"decision_1"}});
  }) as typeof fetch;
  const client=new VeyaAvatarCapability(root,()=>run,{invoke:async()=>{throw Error("unexpected fallback");}});
  const invoke=(operation:string,input:JsonValue={decision_id:"decision_1"})=>client.invoke(VEYA_WORLD_AGENT_CAPABILITY,operation,input,new AbortController().signal,{runId:"run"});
  for(const operation of avatarTools)assert.deepEqual(await invoke(operation),{ok:true,data:{decision_id:"decision_1"}});
  assert.equal(calls.length,8);
  await assert.rejects(invoke("veya.world.apply"),/tool_scope/u);
  await assert.rejects(invoke(avatarTools[0],{decision_id:"other"}),/identity_mismatch/u);
  epoch=8;await assert.rejects(invoke(avatarTools[0]),/context_changed/u);epoch=7;
  run={...run,parent:{runId:"parent"}} as FlowRun;await assert.rejects(invoke(avatarTools[0]),/tool_scope/u);run={...run,parent:undefined};
  await writeFile(path,descriptor+" ");await assert.rejects(invoke(avatarTools[0]),/session_changed/u);
 } finally {
  globalThis.fetch=previous;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});
 }
});
