import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "retained transport errors translate without resubmitting commands, writing history or restarting readers",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check transport languages in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-transport-language-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // The real hooks and command store run against synthetic HTTP and isolated storage.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {initialState, STORAGE_KEY} from ${modulePath("@aura/core")};
import {useWorkspace} from ${source("../src/useWorkspace.ts")};
import {useFlowCatalog} from ${source("../src/flowCatalog.ts")};
import {useWorkflowSessions} from ${source("../src/useWorkflowSessions.ts")};
import {useCodingProjects} from ${source("../src/features/coding/useCodingProjects.ts")};
import {useConversation} from ${source("../src/features/coding/useConversation.ts")};
import {conversations} from ${source("../src/features/coding/conversation-store.ts")};
const endpoint="https://synthetic.invalid",original="用户原文 / Original text";
const requests=[],writes=[],submissions=[],commands=[],snapshots=[],checks=[];
let latest,failSave=false,catalogMode="success",failList=false,streams=0,closes=0;
const setItem=Storage.prototype.setItem,getItem=Storage.prototype.getItem;
Storage.prototype.getItem=function(key){if(key===STORAGE_KEY)throw new Error("Synthetic read failure");return getItem.call(this,key);};
Storage.prototype.setItem=function(key,value){if(key!=="aura.language.v1")writes.push({key,value});if(key===STORAGE_KEY&&failSave)throw new Error("Synthetic save failure");return setItem.call(this,key,value);};
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async(predicate)=>{for(let i=0;i<50&&!predicate();i++)await settle();check(predicate(),"wait completed");};
const epoch="00000000-0000-4000-8000-000000000001";
const snapshot={version:1,sessionId:"channel",cursor:epoch+":0",turns:[],running:false,hasMore:false};
const catalog={flows:[{id:"example",title:original,description:original,inputSchema:{type:"object"}}]};
globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input)),path=url.pathname,method=options?.method??"GET";
  const body=options?.body?JSON.parse(options.body):undefined;
  requests.push({path,method,etag:options?.headers?.["If-None-Match"]});
  if(path==="/flows/catalog")return catalogMode==="fail"?new Response("unavailable",{status:503}):catalogMode==="unchanged"?new Response(null,{status:304}):Response.json(catalog,{headers:{ETag:'"catalog-v1"'}});
  if(path==="/flows/runs")return Response.json([]);
  if(path==="/coding/projects")return Response.json([{id:"project",title:original,directory:"/synthetic"}]);
  if(path==="/coding/projects/project/conversations")return failList?new Response("unavailable",{status:503}):Response.json([{id:"parent",projectId:"project",title:original,createdAt:1,sideConversations:[]}]);
  if(path==="/coding/sessions/parent/side"&&method==="POST"){failList=true;return Response.json({sessionId:"side"});}
  if(path==="/coding/sessions/side/side"&&method==="DELETE")return Response.json({closed:true});
  if(path==="/coding/channel")return Response.json({version:1});
  if(path.endsWith("/snapshot"))return Response.json(snapshot);
  if(path.endsWith("/events")){
    streams++;
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode("event: snapshot\\nid: "+snapshot.cursor+"\\ndata: "+JSON.stringify(snapshot)+"\\n\\n"));
      options.signal.addEventListener("abort",()=>{closes++;controller.close();},{once:true});
    }}),{headers:{"Content-Type":"text/event-stream"}});
  }
  if(path.endsWith("/commands")&&method==="POST"){commands.push(body);throw null;}
  if(path.includes("/commands/"))return new Response("unavailable",{status:404});
  if(path==="/flows/example/runs"){submissions.push(body);throw null;}
  if(path==="/flows/runs/run/cancel")throw null;
  throw new Error("Unexpected synthetic request: "+path);
};
function Fixture(){
  const workspace=useWorkspace(),flows=useFlowCatalog(endpoint),projects=useCodingProjects(endpoint,true,false),channel=useConversation(endpoint,"channel");
  const [state,setState]=React.useState(()=>({...initialState(),endpoint,sessions:[
    {id:"start",title:original,updatedAt:1,messages:[],workflow:{id:"example",title:original,endpoint}},
    {id:"cancel",title:original,updatedAt:1,workflow:{id:"example",title:original,endpoint},messages:[{id:"run:output",role:"assistant",text:"正在运行",status:"streaming",workflowRunId:"run",workflowPhase:"running"}]},
  ]}));
  const workflows=useWorkflowSessions(state,setState,false);
  latest={workspace,flows,projects,channel,workflows,state};
  return React.createElement(React.Fragment,null,
    React.createElement("input",{id:"draft",defaultValue:original}),
    ...Object.entries({storage:workspace.saveError,catalog:flows.error,projects:projects.error,list:projects.conversationErrors.project,command:channel.error,submit:workflows.errors.start,cancel:workflows.errors.cancel}).map(([id,text])=>React.createElement("output",{id,key:id},text??""))
  );
}
const root=createRoot(document.getElementById("root"));
async function inspect(){
  await language.systemChanged(["zh-CN"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(Fixture))));
  await waitFor(()=>latest.projects.conversations.project?.length===1&&!!latest.flows.catalog&&!!latest.channel.snapshot);
  await new Promise(resolve=>setTimeout(resolve,250));await settle();
  catalogMode="fail";await latest.flows.refresh();
  flushSync(()=>latest.projects.open("project","parent"));
  check(await latest.projects.openSide("project","parent")==="side","side created once");
  await waitFor(()=>!!latest.projects.error);
  await latest.workflows.start("start",{text:original},"demo");
  await latest.workflows.cancel("cancel");
  const command={commandId:epoch,type:"turn.start",input:{prompt:original,mode:"demo"}};
  await conversations.submit(endpoint,"channel",command).catch(()=>{});await settle();
  const draft=document.getElementById("draft"),flowCatalog=latest.flows.catalog,pending=latest.state.sessions[0].workflow.pending;
  check(!!pending&&commands.length===1&&submissions.length===1,"unknown operations retained");
  check(streams===1,"one reader");
  async function languages(phase){
    const requestCount=requests.length,writeCount=writes.length,state=latest.workspace.state,records=latest.projects.conversations;
    for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
      await language.select(locale);await settle();
      check(requests.length===requestCount&&writes.length===writeCount,"no requests or writes "+phase+locale);
      check(latest.workspace.state===state&&latest.projects.conversations===records&&latest.flows.catalog===flowCatalog,"cached data retained "+phase+locale);
      check(latest.projects.conversationId==="parent"&&latest.projects.selectedId==="project","workspace selection retained "+phase+locale);
      check(latest.state.sessions[0].workflow.pending===pending&&latest.channel.pending.commandId===epoch,"pending operations retained "+phase+locale);
      check(streams===1&&closes===0,"reader retained "+phase+locale);
      check(document.getElementById("draft")===draft&&draft.value===original,"draft retained "+phase+locale);
      snapshots.push({phase,locale,...Object.fromEntries(["storage","catalog","projects","list","command","submit","cancel"].map(id=>[id,document.getElementById(id).textContent]))});
    }
  }
  await languages("read");
  failSave=true;flushSync(()=>latest.workspace.setState(current=>({...current})));
  await new Promise(resolve=>setTimeout(resolve,250));await settle();
  await languages("save");
  await latest.projects.closeSide("project","side");await waitFor(()=>!latest.projects.conversations.project[0].sideConversations.length);await settle();
  await languages("closed");
  await latest.workflows.start("start",{text:"Must not replace the pending input"},"codex");await settle();
  check(submissions.length===2&&JSON.stringify(submissions[0])===JSON.stringify(submissions[1]),"explicit workflow retry reuses original ID, mode and input");
  check(commands.length===1,"conversation command never resent");
  catalogMode="unchanged";await latest.flows.refresh();await settle();
  check(latest.flows.catalog===flowCatalog&&!latest.flows.error,"304 retains catalog and clears failure");
  const catalogReads=requests.filter(item=>item.path==="/flows/catalog");
  check(catalogReads.length===3&&catalogReads.slice(1).every(item=>item.etag==='"catalog-v1"'),"catalog validator retained");
  flushSync(()=>root.unmount());conversations.close();
  check(closes===1,"reader closed on unmount");
  return {snapshots,checks};
}
inspect().then(value=>document.getElementById("result").textContent=JSON.stringify(value)).catch(error=>document.getElementById("result").textContent=JSON.stringify({error:error.stack??String(error),checks,requests}));
document.currentScript.remove();
`,
    );
    const output = join(directory, "dist");
    await build({
      configFile: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        minify: false,
        lib: {
          entry,
          formats: ["iife"],
          name: "TransportFixture",
          fileName: "fixture",
        },
      },
    });
    const script = await readFile(join(output, "fixture.iife.js"), "utf8");
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(directory, "browser")}`,
        "--window-size=1400,1000",
        "--virtual-time-budget=8000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 25_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "The browser returned transport language results");
    const result = JSON.parse(
      json
        .replaceAll("&nbsp;", "\u00a0")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    ) as {
      error?: string;
      checks: string[];
      snapshots: Array<Record<string, string>>;
    };
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.checks.length > 100);
    assert.equal(result.snapshots.length, 18);
    for (const phase of ["read", "save", "closed"]) {
      const samples = result.snapshots.filter((item) => item.phase === phase);
      for (const field of [
        "storage",
        "catalog",
        "projects",
        "list",
        "command",
        "submit",
        "cancel",
      ])
        assert.equal(
          new Set(samples.map((item) => item[field])).size,
          6,
          `${phase}: ${field}`,
        );
    }
    for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
      const samples = result.snapshots.filter((item) => item.locale === locale);
      assert.notEqual(samples[0].storage, samples[1].storage);
      assert.notEqual(samples[1].projects, samples[2].projects);
    }
  },
);
