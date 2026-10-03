import {createHash,timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {readAvatarBindings,writeAvatarBindings,avatarDecisionFlow,type AvatarBinding,type OrchestrationHost} from "@aura/orchestration";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
type Request={schemaVersion:2;decisionId:string;worldId:string;instanceId:string;worldRevision:number;runtimeEpoch:number;avatarId:string;generation:number;contextHash:string;trigger:string};
const digest=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function request(v:unknown):Request{
 if(!object(v)||Object.keys(v).sort().join(",")!=="avatarId,contextHash,decisionId,generation,instanceId,runtimeEpoch,schemaVersion,trigger,worldId,worldRevision"||v.schemaVersion!==2||
  !["decisionId","worldId","instanceId","avatarId"].every(k=>typeof v[k]==="string"&&/^[A-Za-z0-9_.:-]{1,96}$/u.test(v[k] as string))||
  !["worldRevision","runtimeEpoch","generation"].every(k=>Number.isSafeInteger(v[k])&&(v[k] as number)>=0)||!v.generation||
  typeof v.contextHash!=="string"||!/^[a-f0-9]{16}$/u.test(v.contextHash)||!["intent_missing","intent_completed","intent_failed","schedule_changed","need_threshold","world_changed"].includes(v.trigger as string))throw Error("avatar_request_invalid");
 return v as unknown as Request;
}
export class VeyaAvatarService{
 private queue:Promise<unknown>=Promise.resolve();
 // Plain fields: Node's type stripping rejects constructor parameter properties.
 readonly root:string;
 readonly flow:Pick<OrchestrationHost,"request">;
 readonly token:string;
 readonly fetcher:typeof fetch;
 constructor(root:string,flow:Pick<OrchestrationHost,"request">,token:string,fetcher:typeof fetch=fetch){this.root=root;this.flow=flow;this.token=token;this.fetcher=fetcher;}
 private async context(path:string,r:Request){
  if(!isAbsolute(path))throw Error("avatar_session_invalid");const bytes=await readFile(path);if(bytes.length>8192)throw Error("avatar_session_invalid");const d=JSON.parse(bytes.toString());
  const u=new URL(d.base_url);if(d.protocol!=="veya-world-http/1"||d.tools_protocol!=="veya-agent-tools/1"||d.role==="creator-worker"||u.protocol!=="http:"||u.hostname!=="127.0.0.1"||!u.port||u.pathname!=="/"||u.search||u.hash||u.username||u.password||!/^[a-f0-9]{64}$/u.test(d.token))throw Error("avatar_session_invalid");
  const response=await this.fetcher(new URL("/v2/worlds/status",u),{method:"POST",headers:{Authorization:`Bearer ${d.token}`,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(3000)});
  const envelope=await response.json() as {ok?:boolean;data?:Record<string,unknown>};const status=envelope.data;
  if(!response.ok||envelope.ok!==true||status?.world_id!==r.worldId||status.instance_id!==r.instanceId||status.revision!==r.worldRevision||status.runtime_epoch!==r.runtimeEpoch)throw Error("avatar_session_context_changed");
  return digest(bytes);
 }
 async create(body:unknown){
  if(!object(body)||Object.keys(body).some(k=>!["sessionPath","request"].includes(k))||typeof body.sessionPath!=="string")throw Error("avatar_request_invalid");const r=request(body.request),path=body.sessionPath;
  // Match Godot's sorted JSON encoding; caller property order is not identity.
  const key=digest(JSON.stringify([path,Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b,"en")))]));const requestId=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
  const task=this.queue.then(async()=>{
   const hash=await this.context(path,r),journal=await readAvatarBindings(this.root),old=journal.bindings[key];if(old)return this.query(key,hash);
   if(Object.keys(journal.bindings).length>=1024)throw Error("avatar_dispatch_capacity");
   const row:AvatarBinding={key,requestId,sessionPath:path,sessionHash:hash,request:r as unknown as Record<string,JsonValue>,state:"starting"};journal.bindings[key]=row;await writeAvatarBindings(this.root,journal);
   try{const run=await this.flow.request<FlowRun>("start",{requestId,flowId:avatarDecisionFlow,serviceOnly:true,mode:"codex",input:r});row.runId=run.id;row.state="running";await writeAvatarBindings(this.root,journal);return {key,status:run.status};}
   catch(e){row.state="unknown";await writeAvatarBindings(this.root,journal);throw e;}
  });this.queue=task.catch(()=>undefined);return task;
 }
 async query(key:string,expectedHash?:string){
  if(!/^[a-f0-9]{64}$/u.test(key))throw Error("avatar_decision_key_invalid");
  const row=(await readAvatarBindings(this.root)).bindings[key];if(!row)throw Error("avatar_decision_not_found");const hash=await this.context(row.sessionPath,request(row.request));if(hash!==row.sessionHash||expectedHash&&hash!==expectedHash)throw Error("avatar_session_changed");
  if(!row.runId)return {key,status:"unknown"};if(row.state==="cancelled")return {key,status:"cancelled"};const run=await this.flow.request<FlowRun>("get",{id:row.runId});return {key,status:run.status,...(run.status==="completed"?{result:run.output}:{})};
 }
 async cancel(key:string){if(!/^[a-f0-9]{64}$/u.test(key))throw Error("avatar_decision_key_invalid");const task=this.queue.then(async()=>{const journal=await readAvatarBindings(this.root),row=journal.bindings[key];if(!row)return;row.state="cancelled";await writeAvatarBindings(this.root,journal);if(row.runId)await this.flow.request("cancel",{id:row.runId});});this.queue=task.catch(()=>undefined);await task;return {key,status:"cancelled"};}
}
export function createVeyaAvatarApp(service:VeyaAvatarService){const app=new Hono();app.use("*",bodyLimit({maxSize:8192}));app.use("*",async(c,next)=>{const token=Buffer.from(c.req.header("authorization")?.replace(/^Bearer /u,"")??""),expected=Buffer.from(service.token);if(token.length!==expected.length||!timingSafeEqual(token,expected))return c.json({error:"unauthorized"},401);c.header("Cache-Control","no-store");await next();});
 app.post("/decisions",async c=>c.json(await service.create(await c.req.json()),202));app.get("/decisions/:key",async c=>c.json(await service.query(c.req.param("key"))));app.delete("/decisions/:key",async c=>c.json(await service.cancel(c.req.param("key"))));app.onError((e,c)=>c.json({error:e.message},409));return app;}
