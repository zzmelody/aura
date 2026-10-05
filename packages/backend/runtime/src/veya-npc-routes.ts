import {createHash,timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {readNpcBindings,writeNpcBindings,npcCreationFlow,type NpcBinding,type OrchestrationHost} from "@aura/orchestration";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
const digest=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
type Request={schemaVersion:1;requestId:string;worldId:string;instanceId:string;sourceId:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function request(v:unknown):Request {
 if(!object(v)||Object.keys(v).sort().join(",")!=="instanceId,requestId,schemaVersion,sourceId,worldId"||v.schemaVersion!==1
  ||!["requestId","worldId","instanceId"].every(k=>typeof v[k]==="string"&&/^[A-Za-z0-9_.:-]{1,96}$/u.test(v[k] as string))
  ||typeof v.sourceId!=="string"||!v.sourceId.length||Buffer.byteLength(v.sourceId,"utf8")>128||v.sourceId.includes("\0"))throw Error("npc_request_invalid");
 return v as unknown as Request;
}
export class VeyaNpcService {
 private queue:Promise<unknown>=Promise.resolve();
 readonly root:string;readonly flow:Pick<OrchestrationHost,"request">;readonly token:string;readonly fetcher:typeof fetch;
 constructor(root:string,flow:Pick<OrchestrationHost,"request">,token:string,fetcher:typeof fetch=fetch){this.root=root;this.flow=flow;this.token=token;this.fetcher=fetcher;}
 private async context(path:string,r:Request){
  if(!isAbsolute(path)||path.length>4096)throw Error("npc_session_invalid");
  const bytes=await readFile(path);if(bytes.length>8192)throw Error("npc_session_invalid");const d=JSON.parse(bytes.toString());const u=new URL(d.base_url);
  if(d.protocol!=="veya-world-http/1"||d.tools_protocol!=="veya-agent-tools/1"||d.role==="creator-worker"||u.protocol!=="http:"||u.hostname!=="127.0.0.1"||!u.port||u.pathname!=="/"||u.search||u.hash||u.username||u.password||!/^[a-f0-9]{64}$/u.test(d.token))throw Error("npc_session_invalid");
  const response=await this.fetcher(new URL("/v2/worlds/status",u),{method:"POST",headers:{Authorization:`Bearer ${d.token}`,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)});
  const envelope=await response.json() as {ok?:boolean;data?:Record<string,unknown>};const status=envelope.data;
  if(!response.ok||envelope.ok!==true||status?.world_id!==r.worldId||status.instance_id!==r.instanceId)throw Error("npc_world_changed");
  return digest(bytes);
 }
 async reconcile(body:unknown){
  if(!object(body)||Object.keys(body).sort().join(",")!=="request,sessionPath"||typeof body.sessionPath!=="string")throw Error("npc_request_invalid");
  const r=request(body.request),path=body.sessionPath,key=digest(JSON.stringify([r.worldId,r.requestId]));
  const requestId=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
  const task=this.queue.then(async()=>{
   const hash=await this.context(path,r),journal=await readNpcBindings(this.root);let row=journal.bindings[key];
   if(row){
    if(row.input.worldId!==r.worldId||row.input.sourceId!==r.sourceId||row.input.requestId!==r.requestId)throw Error("npc_identity_conflict");
    // Restore/travel may replace the foreground descriptor and instance. The
    // persisted creation identity remains fixed and never starts another Run.
    if(row.sessionPath!==path||row.sessionHash!==hash||row.input.instanceId!==r.instanceId){row.sessionPath=path;row.sessionHash=hash;row.input={...row.input,instanceId:r.instanceId};await writeNpcBindings(this.root,journal);}
    if(!row.runId)return {key,status:"unknown"};
    const run=await this.flow.request<FlowRun>("get",{id:row.runId});return {key,status:run.status,...(run.status==="completed"?{result:run.output}:{})};
   }
   if(Object.keys(journal.bindings).length>=1024)throw Error("npc_dispatch_capacity");
   row={key,requestId,sessionPath:path,sessionHash:hash,input:r as unknown as Record<string,JsonValue>,state:"starting"} satisfies NpcBinding;
   journal.bindings[key]=row;await writeNpcBindings(this.root,journal);
   try{const run=await this.flow.request<FlowRun>("start",{requestId,flowId:npcCreationFlow,serviceOnly:true,useConfiguredModel:true,mode:"codex",input:r});
    row.runId=run.id;row.state="running";await writeNpcBindings(this.root,journal);return {key,status:run.status,...(run.status==="completed"?{result:run.output}:{})};
   }catch(e){row.state="unknown";await writeNpcBindings(this.root,journal);throw e;}
  });this.queue=task.catch(()=>undefined);return task;
 }
}
export function createVeyaNpcApp(service:VeyaNpcService){const app=new Hono();app.use("*",bodyLimit({maxSize:8192,onError:c=>c.json({error:"npc_request_capacity"},413)}));
 app.use("*",async(c,next)=>{const token=Buffer.from(c.req.header("authorization")?.replace(/^Bearer /u,"")??""),expected=Buffer.from(service.token);
  if(token.length!==expected.length||!timingSafeEqual(token,expected))return c.json({error:"unauthorized"},401);c.header("Cache-Control","no-store");await next();});
 app.post("/recruitments",async c=>c.json(await service.reconcile(await c.req.json()),202));app.onError((e,c)=>c.json({error:e.message},409));return app;
}
