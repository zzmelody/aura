import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {join,isAbsolute} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
import {ActionFailure,type AuraCapabilityClient} from "./action-api.ts";
import {VeyaWorldAgentCapability,VEYA_WORLD_AGENT_CAPABILITY} from "./veya-world-agent.ts";
export const npcCreationFlow="veya/veya-npc-agent";
export type NpcBinding={key:string;requestId:string;sessionPath:string;sessionHash:string;input:Record<string,JsonValue>;runId?:string;state:"starting"|"running"|"unknown"};
export type NpcJournal={version:1;bindings:Record<string,NpcBinding>};
const directory=(root:string)=>join(root,".aura","veya-npc");
const file=(root:string)=>join(directory(root),"bindings.json");
export async function readNpcBindings(root:string):Promise<NpcJournal>{
 try{const bytes=await readFile(file(root));if(bytes.length>1024*1024)throw Error("npc_binding_capacity");const value=JSON.parse(bytes.toString());
  if(value.version!==1||!value.bindings||typeof value.bindings!=="object"||Array.isArray(value.bindings)||Object.keys(value.bindings).length>1024)throw Error("npc_binding_invalid");return value;
 }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,bindings:{}};throw e;}
}
export async function writeNpcBindings(root:string,value:NpcJournal){
 const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>1024*1024)throw Error("npc_binding_capacity");
 await mkdir(directory(root),{recursive:true});const temp=file(root)+"."+randomUUID()+".tmp";
 await writeFile(temp,bytes,{flag:"wx",mode:0o600});await rename(temp,file(root));
}
export class VeyaNpcCapability implements AuraCapabilityClient {
 readonly root:string;readonly get:(id:string)=>FlowRun;readonly fallback:AuraCapabilityClient;
 constructor(root:string,get:(id:string)=>FlowRun,fallback:AuraCapabilityClient){this.root=root;this.get=get;this.fallback=fallback;}
 async invoke(capability:string,operation:string,input:JsonValue,signal:AbortSignal,context?:{readonly runId?:string}):Promise<JsonValue>{
  const run=context?.runId?this.get(context.runId):undefined;
  if(run?.flow.id!==npcCreationFlow)return this.fallback.invoke(capability,operation,input,signal,context);
  const sdk=["veya.sdk.list","veya.sdk.grep","veya.sdk.read"].includes(operation);
  if(run.parent||capability!==VEYA_WORLD_AGENT_CAPABILITY||operation!=="veya.npc.creation.context"&&!sdk)throw new ActionFailure("npc_tool_scope");
  const row=Object.values((await readNpcBindings(this.root)).bindings).find(b=>b.requestId===run.requestId);
  if(!row||row.state==="unknown"||row.runId&&row.runId!==run.id||!isAbsolute(row.sessionPath))throw new ActionFailure("npc_binding_unavailable");
  const bytes=await readFile(row.sessionPath);
  if(bytes.length>8192||createHash("sha256").update(bytes).digest("hex")!==row.sessionHash)throw new ActionFailure("npc_session_changed");
  if(!input||typeof input!=="object"||Array.isArray(input)||!sdk&&(input as Record<string,JsonValue>).request_id!==row.input.requestId)throw new ActionFailure("npc_request_mismatch");
  const client=new VeyaWorldAgentCapability(row.sessionPath);
  const status=await client.invoke(capability,"veya.world.status",{},signal) as Record<string,JsonValue>;
  if(status.world_id!==row.input.worldId||status.instance_id!==row.input.instanceId)throw new ActionFailure("npc_world_changed");
  if(sdk){
   const args=input as Record<string,JsonValue>;
   if(args.profile!==undefined&&args.profile!=="npc_resident")throw new ActionFailure("npc_sdk_scope");
   const catalog=await client.invoke(capability,"veya.sdk.list",{profile:"npc_resident"},signal) as Record<string,JsonValue>;
   if(!Array.isArray(catalog.documents))throw new ActionFailure("sdk_upgrade_required");
   const allowed=new Set(catalog.documents.map(d=>(d as Record<string,JsonValue>).id));
   if(operation!=="veya.sdk.list"&&args.sdk_hash!==catalog.sdk_hash)throw new ActionFailure("sdk_version_conflict");
   if(operation==="veya.sdk.read"&&!allowed.has(args.id))throw new ActionFailure("npc_sdk_scope");
   if(args.ids!==undefined&&(!Array.isArray(args.ids)||args.ids.some(id=>!allowed.has(id))))throw new ActionFailure("npc_sdk_scope");
   const data=await client.invoke(capability,operation,operation==="veya.sdk.read"?args:{...args,profile:"npc_resident"},signal);
   return {ok:true,data};
  }
  const data=await client.invoke(capability,operation,input,signal) as Record<string,JsonValue>;
  if(data.requestId!==row.input.requestId||data.sourceId!==row.input.sourceId||data.worldId!==row.input.worldId)throw new ActionFailure("npc_source_changed");
  return {ok:true,data};
 }
}
