import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
import {VeyaNpcCapability,npcCreationFlow,writeNpcBindings} from "../src/veya-npc-bindings.ts";
import {VEYA_WORLD_AGENT_CAPABILITY} from "../src/veya-world-agent.ts";
test("NPC Flow gets only its bound native context and rejects world/session/request substitution",async()=>{
 const root=await mkdtemp(join(tmpdir(),"aura-npc-binding-")),path=join(root,"session.json"),previous=globalThis.fetch;
 try {
  const descriptor=JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",token:"a".repeat(64)});
  await writeFile(path,descriptor);const input={requestId:"recruitment_1",worldId:"world",instanceId:"foreground",sourceId:"pavilion"};
  await writeNpcBindings(root,{version:1,bindings:{key:{key:"key",requestId:"request",sessionPath:path,sessionHash:createHash("sha256").update(descriptor).digest("hex"),input,runId:"run",state:"running"}}});
  let run={id:"run",requestId:"request",flow:{id:npcCreationFlow}} as FlowRun,instance="foreground";
  const sdkHash="b".repeat(64),requests:Array<{tool:string;arguments:Record<string,JsonValue>}>=[];
  globalThis.fetch=(async(_url,init)=>{const request=JSON.parse(String(init?.body??"{}"));requests.push(request);const tool=request.tool;
   return Response.json({ok:true,data:tool==="veya.world.status"?{world_id:"world",instance_id:instance}:tool==="veya.sdk.list"?{sdk_hash:sdkHash,documents:[{id:"npc.resident",profiles:["npc_resident"]},{id:"common.types",profiles:["npc_resident"]}],required:{npc_resident:["npc.resident"]}}:tool.startsWith("veya.sdk.")?{sdk_hash:sdkHash,matches:[],complete:true,text:"居民"}:{requestId:input.requestId,worldId:"world",sourceId:"pavilion"}});
  }) as typeof fetch;
  const capability=new VeyaNpcCapability(root,()=>run,{invoke:async()=>{throw Error("unexpected fallback");}});
  const invoke=(operation="veya.npc.creation.context",value:JsonValue={request_id:input.requestId})=>capability.invoke(VEYA_WORLD_AGENT_CAPABILITY,operation,value,new AbortController().signal,{runId:"run"});
  assert.deepEqual(await invoke(),{ok:true,data:{requestId:input.requestId,worldId:"world",sourceId:"pavilion"}});
  await assert.rejects(invoke("veya.world.apply"),/tool_scope/u);
  await assert.rejects(invoke(undefined,{request_id:"other"}),/request_mismatch/u);
  await invoke("veya.sdk.list",{});
  await invoke("veya.sdk.read",{id:"common.types",sdk_hash:sdkHash});
  await invoke("veya.sdk.grep",{query:"日程",sdk_hash:sdkHash});
  assert.equal(requests.at(-1)?.arguments.profile,"npc_resident");
  await assert.rejects(invoke("veya.sdk.list",{profile:"cooker"}),/sdk_scope/u);
  await assert.rejects(invoke("veya.sdk.read",{id:"cooker.overview",sdk_hash:sdkHash}),/sdk_scope/u);
  await assert.rejects(invoke("veya.sdk.grep",{query:"x",ids:["cooker.overview"],sdk_hash:sdkHash,cursor:"forged"}),/sdk_scope/u);
  await assert.rejects(invoke("veya.sdk.grep",{query:"x",sdk_hash:"c".repeat(64)}),/version_conflict/u);
  instance="other";await assert.rejects(invoke(),/world_changed/u);instance="foreground";
  run={...run,parent:{runId:"parent"}} as FlowRun;await assert.rejects(invoke(),/tool_scope/u);run={...run,parent:undefined};
  await writeFile(path,descriptor+" ");await assert.rejects(invoke(),/session_changed/u);
 }finally{globalThis.fetch=previous;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
