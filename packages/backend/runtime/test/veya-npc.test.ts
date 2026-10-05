import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import type {OrchestrationHost} from "@aura/orchestration";
import {VeyaNpcService,createVeyaNpcApp} from "../src/veya-npc-routes.ts";
const token="a".repeat(64),input={schemaVersion:1,requestId:"request_1",worldId:"world",instanceId:"instance",sourceId:"pavilion"};
async function fixture(run:(root:string,path:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),"aura-npc-")),path=join(root,"session.json");
 try{await writeFile(path,JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",token}));await run(root,path);}
 finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}}
const fetcher=(instance="instance")=>async()=>Response.json({ok:true,data:{world_id:"world",instance_id:instance}});
test("NPC request identity survives service restart and a changed game instance",async()=>fixture(async(root,path)=>{
 let starts=0;const port={request:async(method:string,body:Record<string,unknown>)=>{
  if(method==="start"){starts++;assert.equal(body.flowId,"veya/veya-npc-agent");assert.equal(body.serviceOnly,true);}
  return {id:"run",status:method==="start"?"running":"completed",output:{...input,decision:{status:"skipped",reason:"decoration"}}};
 }} as Pick<OrchestrationHost,"request">;
 const first=await new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:input});
 const restored=await new VeyaNpcService(root,port,token,fetcher("restored") as typeof fetch).reconcile({sessionPath:path,request:{...input,instanceId:"restored"}});
 assert.equal(first.key,restored.key);assert.equal(restored.status,"completed");assert.equal(starts,1);
 await new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:{...input,requestId:"request_2",sourceId:"河谷茶馆"}});
 assert.equal(starts,2);
 await assert.rejects(new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:{...input,sourceId:"different"}}),/identity_conflict/u);
}));
test("unknown dispatch receipt is never sent to the model a second time",async()=>fixture(async(root,path)=>{
 let starts=0;const port={request:async()=>{starts++;throw Error("unknown acknowledgement");}} as unknown as Pick<OrchestrationHost,"request">;
 await assert.rejects(new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:input}),/unknown acknowledgement/u);
 const result=await new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:input});
 assert.equal(result.status,"unknown");assert.equal(starts,1);
}));
test("NPC foreground context and authenticated bounded route reject stale or worker calls",async()=>fixture(async(root,path)=>{
 let starts=0;const port={request:async()=>{starts++;return {};}} as unknown as Pick<OrchestrationHost,"request">;
 const service=new VeyaNpcService(root,port,token,fetcher("different") as typeof fetch);
 await assert.rejects(service.reconcile({sessionPath:path,request:input}),/world_changed/u);assert.equal(starts,0);
 await writeFile(path,JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",token,role:"creator-worker"}));
 await assert.rejects(new VeyaNpcService(root,port,token,fetcher() as typeof fetch).reconcile({sessionPath:path,request:input}),/session_invalid/u);
 const app=createVeyaNpcApp(service);
 assert.equal((await app.request("/recruitments",{method:"POST",headers:{authorization:"Bearer "+"é".repeat(64)}})).status,401);
 assert.equal((await app.request("/recruitments",{method:"POST",headers:{authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({padding:"x".repeat(8192)})})).status,413);
}));
