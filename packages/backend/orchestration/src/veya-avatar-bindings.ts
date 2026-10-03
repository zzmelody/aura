import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {join,isAbsolute} from "node:path";
import {randomUUID} from "node:crypto";
import type {FlowRun,JsonValue} from "@aura/protocol/types";
import {ActionFailure,type AuraCapabilityClient} from "./action-api.ts";
import {VeyaWorldAgentCapability,VEYA_WORLD_AGENT_CAPABILITY} from "./veya-world-agent.ts";
export const avatarDecisionFlow="veya/veya-avatar-decision-agent";
export const avatarTools=["veya.avatar.decision.context","veya.avatar.memory.search","veya.avatar.perception.query","veya.avatar.plan.validate"];
export type AvatarBinding={key:string;requestId:string;sessionPath:string;sessionHash:string;request:Record<string,JsonValue>;runId?:string;state:"starting"|"running"|"unknown"|"cancelled"};
export type AvatarJournal={version:1;bindings:Record<string,AvatarBinding>};
const file=(root:string)=>join(root,".aura","veya-avatar","bindings.json");
export async function readAvatarBindings(root:string):Promise<AvatarJournal>{
 try{const bytes=await readFile(file(root));if(bytes.length>512*1024)throw Error("avatar_binding_capacity");const value=JSON.parse(bytes.toString());if(value.version!==1||!value.bindings||Object.keys(value.bindings).length>1024)throw Error("avatar_binding_invalid");return value;}
 catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,bindings:{}};throw e;}
}
export async function writeAvatarBindings(root:string,value:AvatarJournal){
 const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>512*1024)throw Error("avatar_binding_capacity");await mkdir(join(root,".aura","veya-avatar"),{recursive:true});const temporary=file(root)+"."+randomUUID()+".tmp";await writeFile(temporary,bytes,{flag:"wx",mode:0o600});await rename(temporary,file(root));
}
export class VeyaAvatarCapability implements AuraCapabilityClient{
 // Plain fields: Node's type stripping rejects constructor parameter properties.
 readonly root:string;
 readonly get:(id:string)=>FlowRun;
 readonly fallback:AuraCapabilityClient;
 constructor(root:string,get:(id:string)=>FlowRun,fallback:AuraCapabilityClient){this.root=root;this.get=get;this.fallback=fallback;}
 async invoke(capability:string,operation:string,input:JsonValue,signal:AbortSignal,context?:{readonly runId?:string}):Promise<JsonValue>{
  const run=context?.runId?this.get(context.runId):undefined;
  if(run?.flow.id!==avatarDecisionFlow)return this.fallback.invoke(capability,operation,input,signal,context);
  if(capability!==VEYA_WORLD_AGENT_CAPABILITY||!avatarTools.includes(operation)||run.parent)throw new ActionFailure("avatar_decision_tool_scope");
  const binding=Object.values((await readAvatarBindings(this.root)).bindings).find(b=>b.requestId===run.requestId);
  if(!binding||binding.state==="cancelled"||binding.state==="unknown"||binding.runId&&binding.runId!==run.id||!isAbsolute(binding.sessionPath))throw new ActionFailure("avatar_source_binding_unavailable");
  const bytes=await readFile(binding.sessionPath),{createHash}=await import("node:crypto");
  if(bytes.length>8192||createHash("sha256").update(bytes).digest("hex")!==binding.sessionHash)throw new ActionFailure("avatar_source_session_changed");
  const body=input as Record<string,JsonValue>;
  if(body.decision_id!==binding.request.decisionId)throw new ActionFailure("avatar_decision_identity_mismatch");
  const client=new VeyaWorldAgentCapability(binding.sessionPath);
  const status=await client.invoke(capability,"veya.world.status",{},signal) as Record<string,JsonValue>;
  if(status.world_id!==binding.request.worldId||status.instance_id!==binding.request.instanceId||status.revision!==binding.request.worldRevision||status.runtime_epoch!==binding.request.runtimeEpoch)throw new ActionFailure("avatar_source_context_changed");
  const data=await client.invoke(capability,operation,input,signal);return {ok:true,data};
 }
}
