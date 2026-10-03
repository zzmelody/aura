import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import type {OrchestrationHost} from "@aura/orchestration";
import {VeyaAvatarService,createVeyaAvatarApp} from "../src/veya-avatar-routes.ts";
const token="a".repeat(64);
const input={schemaVersion:2,decisionId:"avatar_guide_1",avatarId:"npc_guide:guide",worldId:"world",instanceId:"instance",worldRevision:3,runtimeEpoch:7,generation:1,contextHash:"0123456789abcdef",trigger:"intent_missing"};
async function fixture(run:(root:string,sessionPath:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),"aura-avatar-")),sessionPath=join(root,"session.json");
 try{await writeFile(sessionPath,JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",token,pid:42}));await run(root,sessionPath);}
 finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}}
const fetcher=(epoch=7)=>async()=>Response.json({ok:true,data:{world_id:"world",instance_id:"instance",revision:3,runtime_epoch:epoch}});
test("Avatar dispatch pins one foreground source, fixed Flow, and persisted dedup identity",async()=>fixture(async(root,sessionPath)=>{
 const calls:Array<{method:string,body:Record<string,unknown>}>=[];
 const port={request:async(method:string,body:Record<string,unknown>)=>{calls.push({method,body});return {id:"run",status:method==="start"?"running":"completed",output:{status:"accepted",runtimeEpoch:7}};}} as Pick<OrchestrationHost,"request">;
 const service=new VeyaAvatarService(root,port,token,fetcher() as typeof fetch);
 const first=await service.create({sessionPath,request:input});assert.equal(first.status,"running");
 const again=await new VeyaAvatarService(root,port,token,fetcher() as typeof fetch).create({sessionPath,request:Object.fromEntries(Object.entries(input).reverse())});
 assert.equal(again.key,first.key);assert.equal(calls.filter(c=>c.method==="start").length,1);
 assert.equal(calls[0].body.flowId,"veya/veya-avatar-decision-agent");assert.equal(calls[0].body.serviceOnly,true);
 const result=await service.query(first.key);assert.equal(result.status,"completed");
 await service.cancel(first.key);assert.equal((await service.query(first.key)).status,"cancelled");assert.ok(calls.some(c=>c.method==="cancel"));
}));
test("Unknown start acknowledgement survives restart without another model request",async()=>fixture(async(root,sessionPath)=>{
 let starts=0;const port={request:async()=>{starts++;throw Error("unknown receipt");}} as unknown as Pick<OrchestrationHost,"request">;
 await assert.rejects(new VeyaAvatarService(root,port,token,fetcher() as typeof fetch).create({sessionPath,request:input}),/unknown receipt/u);
 const resumed=await new VeyaAvatarService(root,port,token,fetcher() as typeof fetch).create({sessionPath,request:input});assert.equal(resumed.status,"unknown");assert.equal(starts,1);
}));
test("Stale epoch and Creator worker reject before dispatch; endpoint authentication is bounded",async()=>fixture(async(root,sessionPath)=>{
 let starts=0;const port={request:async()=>{starts++;return {};}} as unknown as Pick<OrchestrationHost,"request">;
 await assert.rejects(new VeyaAvatarService(root,port,token,fetcher(8) as typeof fetch).create({sessionPath,request:input}),/context_changed/u);
 await writeFile(sessionPath,JSON.stringify({protocol:"veya-world-http/1",tools_protocol:"veya-agent-tools/1",base_url:"http://127.0.0.1:49152",role:"creator-worker",token}));
 const service=new VeyaAvatarService(root,port,token,fetcher() as typeof fetch);await assert.rejects(service.create({sessionPath,request:input}),/session_invalid/u);assert.equal(starts,0);
 const app=createVeyaAvatarApp(service);assert.equal((await app.request("/decisions",{method:"POST",headers:{authorization:"Bearer "+"é".repeat(64)}})).status,401);
 assert.equal((await app.request("/decisions",{method:"POST",headers:{authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({sessionPath,request:{...input,schemaVersion:1}})})).status,409);
}));
