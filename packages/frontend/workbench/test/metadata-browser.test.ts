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
  "static plugin metadata translates catalog and schema displays without changing drafts, requests or contribution identities",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check metadata displays"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-metadata-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Real catalog hook, plugin settings, library and form; HTTP is synthetic and no Flow executes.
    await writeFile(
      entry,
      `
import React,{useState} from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language,locales} from ${modulePath("@aura/i18n/runtime")};
import {useFlowCatalog} from ${source("../src/flowCatalog.ts")};
import {PluginList} from ${source("../src/screens/Plugins.tsx")};
import {Workflows} from ${source("../src/screens/Workflows.tsx")};
import {WorkflowInput} from ${source("../src/screens/WorkflowInput.tsx")};
import {WorkflowData} from ${source("../src/screens/WorkflowValue.tsx")};
import {catalog,settings,metadata} from ${source("./fixtures/metadata.ts")};
const endpoint="https://synthetic.invalid",original=JSON.stringify(catalog),checks=[],snapshots=[],requests=[],runs=[];
const noop=()=>{},pages=new Map(),analysis={entries:[]};
let catalogState,text,changes=0,writes=0,nextCatalog=structuredClone(catalog),nextSettings=structuredClone(settings);
const setItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){writes++;return setItem.call(this,key,value);};
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const query=selector=>{const element=document.querySelector(selector);if(!element)throw new Error("Missing "+selector);return element;};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async predicate=>{for(let i=0;i<60&&!predicate();i++)await settle();check(predicate(),"wait completed");};
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname,body=options?.body?JSON.parse(options.body):undefined;
  requests.push({path,body,method:options?.method??"GET"});
  if(path==="/flows/catalog")return Response.json(nextCatalog,{headers:{ETag:'"metadata"'}});
  if(path==="/plugins/config"){
    if(body){nextSettings.plugins[0].enabled=body.plugins[0].enabled;nextSettings.plugins[0].status.enabled=body.plugins[0].enabled;nextSettings.plugins[0].status.available=body.plugins[0].enabled;}
    return Response.json(nextSettings);
  }
  throw new Error("Unexpected request "+path);
};
function Fixture(){
  catalogState=useFlowCatalog(endpoint);
  const [draft,setDraft]=useState(JSON.stringify({prompt:"",mode:"brief",tags:[]}));
  text=draft;
  const flow=catalogState.catalog?.flows[0];
  return React.createElement(React.Fragment,null,
    React.createElement(PluginList,{endpoint,settingsPages:pages,onOpenSettings:noop}),
    React.createElement(Workflows,{endpoint,catalogState,browseRevision:0,editorRevision:0,draft:{},analysis,onDetailChange:noop,onRun:flow=>runs.push(JSON.stringify(flow))}),
    flow?React.createElement("section",{id:"form"},React.createElement(WorkflowInput,{schema:flow.inputSchema,text:draft,disabled:false,onChange:value=>{changes++;setDraft(value);}})):null,
    flow?React.createElement("section",{id:"output"},React.createElement(WorkflowData,{schema:flow.outputSchema,value:[{count:17}]})):null);
}
const root=createRoot(document.getElementById("root"));
async function inspect(){
  await language.systemChanged(["en"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(Fixture))));
  await waitFor(()=>document.querySelector("#form textarea")&&document.querySelector(".plugins-title strong"));
  const prompt=query("#form textarea"),select=query("#form select"),checkbox=query("#form .workflow-multi-select input"),asset=query("#form .workflow-input-image-asset input[type=text]");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(prompt,"用户草稿 / Draft {{literal}}");
  prompt.dispatchEvent(new Event("input",{bubbles:true}));await settle();
  select.value=JSON.stringify("full");select.dispatchEvent(new Event("change",{bubbles:true}));checkbox.click();await settle();
  check(JSON.stringify(JSON.parse(text))===JSON.stringify({prompt:"用户草稿 / Draft {{literal}}",mode:"full",tags:["brief"]}),"original enum values and edited draft");
  prompt.focus();
  const draft=text,changeCount=changes,writeCount=writes,calls=requests.length;
  for(const locale of locales){
    await language.systemChanged([locale]);await settle();
    const words=metadata.catalogs[locale];
    const sample={locale,name:query(".plugins-title strong").textContent,title:query(".workflow-card-copy strong").textContent,prompt:prompt.getAttribute("aria-label"),count:query("#output th").textContent};
    check(sample.name===words.name&&sample.title===words.title,"localized plugin and flow titles");
    check(query(".plugins-description").textContent===words.description&&query(".workflow-card-copy span").textContent===words.description,"localized descriptions");
    check(sample.prompt===words.prompt&&prompt.placeholder===words.hint&&asset.placeholder===words.hint,"localized field labels and explicit placeholders");
    check(select.options[0].text===words.short&&select.options[1].text===words.full,"localized enum labels");
    check(query(".workflow-option span").textContent===words.short&&query(".workflow-multi-select").getAttribute("aria-describedby"),"multi-select labels and accessible hint");
    check(sample.count===words.count,"localized output column");
    check(query("#form textarea")===prompt&&query("#form select")===select&&query("#form .workflow-multi-select input")===checkbox&&query("#form .workflow-input-image-asset input[type=text]")===asset,"same field nodes");
    check(text===draft&&select.value===JSON.stringify("full")&&checkbox.checked&&document.activeElement===prompt,"draft values and focus retained");
    check(changes===changeCount&&writes===writeCount&&requests.length===calls,"no operations on language change");
    check(JSON.stringify(catalogState.catalog)===original&&JSON.stringify(catalog)===original,"raw catalog and schemas unchanged");
    snapshots.push(sample);
  }
  query(".workflow-run-icon").click();await settle();
  check(runs.length===1&&runs[0]===JSON.stringify(catalog.flows[0]),"run selection carries original identity title and schema");
  const switchInput=query(".plugins-card input[role=switch]");switchInput.click();await waitFor(()=>!switchInput.disabled);
  check(!switchInput.checked&&query(".plugins-title strong").textContent===metadata.catalogs.fr.name,"disabled plugin retains display metadata");
  const saved=requests.filter(item=>item.method==="POST");
  check(saved.length===1&&JSON.stringify(saved[0].body)===JSON.stringify({plugins:[{path:settings.plugins[0].path,enabled:false}]}),"explicit toggle saves original path and flag only");
  nextCatalog.plugins[0].localization.catalogs.fr.prompt="Nouveau contenu";
  await catalogState.refresh();await settle();
  check(prompt.getAttribute("aria-label")==="Nouveau contenu"&&query("#form textarea")===prompt&&text===draft,"catalog refresh replaces resources without resetting draft");
  check(query(".plugins-title strong").textContent===metadata.catalogs.fr.name,"settings resource owner remains independent");
  nextCatalog.flows[0].error="original definition warning";
  nextCatalog.flows[0].errorDetails={code:"flow_source_promise",params:{line:12,method:"race"}};
  await catalogState.refresh();await settle();
  const warningCalls=requests.length,warningTexts=new Set();
  for(const locale of locales){
    await language.systemChanged([locale]);await settle();
    const warning=query(".workflow-card-status").title;
    warningTexts.add(warning);
    check(warning.includes("12")&&warning.includes("Promise.race")&&!warning.includes("original definition warning"),"catalog warning translates its retained source location");
    check(requests.length===warningCalls&&text===draft&&query("#form textarea")===prompt,"warning translation retains draft and makes no request");
    check(catalogState.catalog.flows[0].error==="original definition warning","catalog raw diagnostic remains unchanged");
  }
  check(warningTexts.size===6,"catalog warning covers six languages");
  nextSettings.plugins[0].enabled=true;
  Object.assign(nextSettings.plugins[0].status,{enabled:true,available:false,error:"old plugin diagnostic",errorDetails:{code:"plugin_sdk_incompatible"}});
  query(".plugins-manager-head button").click();await waitFor(()=>!query(".plugins-manager-head button").disabled);await settle();
  const pluginCalls=requests.length;
  for(const locale of locales){
    await language.systemChanged([locale]);await settle();
    const error=query(".plugins-description");
    check(error.textContent===language.i18n.t("plugin_sdk_incompatible",{ns:"apiErrors"})&&error.title===error.textContent,"plugin validation failure and tooltip translate");
    check(requests.length===pluginCalls&&text===draft&&query("#form textarea")===prompt,"plugin validation translation makes no request or draft change");
  }
  nextCatalog={flows:[],actions:[],plugins:[],presets:[]};await catalogState.refresh();await settle();
  check(!document.querySelector("#form")&&query(".plugins-title strong").textContent===metadata.catalogs.fr.name,"catalog removal leaves settings metadata alive");
  root.unmount();
  const namespaces=Object.values(language.i18n.store.data).flatMap(bundles=>Object.keys(bundles));
  check(!namespaces.some(name=>name.startsWith("metadata.")),"unmount removes all owned metadata resources");
  document.getElementById("result").textContent=JSON.stringify({checks,snapshots});
}
inspect().catch(error=>{root.unmount();document.getElementById("result").textContent=JSON.stringify({error:String(error),checks,requests,snapshots});});
`,
    );
    const output = join(directory, "bundle");
    await build({
      configFile: false,
      root: directory,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        minify: true,
        lib: {
          entry,
          formats: ["iife"],
          name: "Metadata",
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
    assert.ok(json, "Browser returned metadata results");
    const result = JSON.parse(
      json
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    ) as {
      error?: string;
      checks: string[];
      snapshots: Array<Record<string, string>>;
    };
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.snapshots.length, 6);
    assert.ok(result.checks.length > 65);
    for (const field of ["name", "title", "prompt", "count"])
      assert.equal(
        new Set(result.snapshots.map((item) => item[field])).size,
        6,
        field,
      );
  },
);
