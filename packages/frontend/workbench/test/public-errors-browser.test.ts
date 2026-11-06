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
  "product plugins and login retain local and coded server errors across language changes without invoking operations again",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check public error consumers"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-public-errors-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Real plugin components, host transports and auth hook; all HTTP/native ports are synthetic.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language,locales,registerCatalogs} from ${modulePath("@aura/i18n/runtime")};
import {chooseSiteDirectory,openSitePreview} from ${source("../src/plugin-api.ts")};
import {invokePluginPage} from ${source("../src/pluginPages.ts")};
import {useCodexAuth} from ${source("../src/useCodexAuth.ts")};
import {desktopBrowserHost} from ${source("../src/platform.ts")};
import {BrowserPane} from ${source("../src/features/coding/BrowserPane.tsx")};
import {SiteScreen} from ${source("../../../../plugins/site-launcher/client/src/SiteScreen.tsx")};
import {translations as siteTranslations} from ${source("../../../../plugins/site-launcher/client/src/messages.ts")};
import {TripoSettingsPage} from ${source("../../../../plugins/tripo/client/src/TripoSettingsPage.tsx")};
import {translations as tripoTranslations} from ${source("../../../../plugins/tripo/client/src/messages.ts")};
import {tripoErrorMessages} from ${source("../../../../plugins/tripo/shared/error-messages.ts")};
const endpoint="https://synthetic.invalid",original="用户原文 / Original project";
const project={id:"project",name:original,directory:"/original/project",packageManager:"pnpm",script:"dev",scripts:["dev"],url:"http://localhost:3000"};
localStorage.setItem("aura.sites.v2",JSON.stringify([project]));
registerCatalogs("plugin.site-launcher",siteTranslations);
registerCatalogs("plugin.aura.tripo",tripoTranslations);
let auth,statusListener,subscriptions=0,cleanups=0,writes=0,popupAttempts=0,cancelPicker=false,nativeCalls=0,codedAuth=false;
let statusReply={state:"signed_out",model:"original-model"};
const requests=[],checks=[],snapshots=[],dirty=[];
const setItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){writes++;return setItem.call(this,key,value);};
window.auraHost={platform:"desktop",browser:{
  acquire:async()=>{nativeCalls++;return {type:"aura.native.failure",code:"browserTabLimit"};},
  release:async()=>{throw new Error("No lease was acquired");},
  navigate:async()=>{throw new Error("No lease was acquired");},
  openExternal:async()=>{throw new Error("No lease was acquired");},
}};
const browserHost=desktopBrowserHost(),onPage=()=>{};
window.open=()=>{popupAttempts++;return null;};
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async(predicate)=>{for(let i=0;i<50&&!predicate();i++)await settle();check(predicate(),"wait completed");};
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname,body=options?.body?JSON.parse(options.body):undefined;
  requests.push({path,body});
  if(path==="/auth/codex/status")return Response.json(statusReply);
  if(path==="/auth/codex/start")return codedAuth?Response.json({message:"old login failure",code:"auth_callback_expired"},{status:400}):Response.json({state:"pending",model:"original-model",authUrl:"https://auth.example.invalid"});
  if(path.includes("aura.tripo/invoke"))return Response.json({message:"legacy readable message",code:"plugin_failure",params:{translations:tripoErrorMessages("resultUnknown"),token:"private-must-not-render"}},{status:503});
  if(path.includes("site-launcher/invoke")&&body.operation==="stop")return Response.json({message:"page_operation_failed",code:"plugin_failure",params:{translations:Object.fromEntries(locales.map(locale=>[locale,siteTranslations[locale].previewNotReady]))}},{status:422});
  if(path.startsWith("/plugins/pages/"))return Response.json({message:"legacy readable message",code:"connection_interrupted",params:{token:"private-must-not-render"}},{status:503});
  throw new Error("Unexpected synthetic request: "+path);
};
const host={
  chooseDirectory:()=>cancelPicker?Promise.resolve(null):chooseSiteDirectory(),
  start:()=>invokePluginPage(endpoint,"site-launcher","start",{...project}),
  stop:id=>invokePluginPage(endpoint,"site-launcher","stop",{id}),
  open:()=>openSitePreview(project.url,project.id,project.name),
  onStatus(callback){subscriptions++;statusListener=callback;return()=>{cleanups++;};},
};
const invoke=(operation,input,signal)=>invokePluginPage(endpoint,"aura.tripo",operation,input,signal);
const onDirtyChange=value=>dirty.push(value);
const workspace={ready:true,state:{endpoint,provider:"codex"},setState:()=>{throw new Error("Unexpected workspace write");}};
function Fixture(){
  auth=useCodexAuth(workspace);
  return React.createElement(React.Fragment,null,
    React.createElement("output",{id:"auth"},auth.status.state==="error"?auth.status.message:""),
    React.createElement("section",{id:"browser"},React.createElement(BrowserPane,{id:"browser",workspace:"original-workspace",visible:true,host:browserHost,onPage})),
    React.createElement(SiteScreen,{host}),
    React.createElement("section",{id:"tripo"},React.createElement(TripoSettingsPage,{endpoint,pluginId:"aura.tripo",invoke,onDirtyChange,onBack:()=>{}})));
}
const query=selector=>{const element=document.querySelector(selector);if(!element)throw new Error("Missing "+selector);return element;};
const root=createRoot(document.getElementById("root"));
async function inspect(){
  await language.systemChanged(["en"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(Fixture))));
  await waitFor(()=>!auth.loading&&document.querySelector("#tripo [role=alert]"));
  await auth.start("browser");await settle();
  check(auth.status.state==="error"&&popupAttempts===2,"blocked login reported after original attempt");
  query(".site-add-project").click();await settle();
  query(".site-run-actions .primary-button").click();await waitFor(()=>document.querySelector(".site-run-icon.error"));
  const input=query(".site-fields input");
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  setter.call(input,"http://localhost:4555/unsaved");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));await settle();
  for(const phase of ["start","stop","open","native"]){
    if(phase==="native"){
      window.auraHost.directories={choose:async()=>{nativeCalls++;return {type:"aura.native.failure",code:"pickerFailed"};}};
      window.auraHost.previews={open:async()=>{nativeCalls++;return {type:"aura.native.failure",code:"previewLocalOnly"};}};
      query(".site-add-project").click();await settle();
    }
    if(phase!=="start"){
      flushSync(()=>statusListener({state:"running",project,pid:42,previewReady:true}));
      query(phase==="stop"?".site-stop-button":".site-run-actions .tool-button").click();
      await waitFor(()=>document.querySelector(".site-run-icon.error"));
    }
    const focusTarget=input.disabled?query(".site-project-item"):input;
    focusTarget.focus();
    const draft=input.value,calls=requests.length,writeCount=writes,dirtyCount=dirty.length,nativeCount=nativeCalls;
    for(const locale of locales){
      await language.systemChanged([locale]);await settle();
      const sample={phase,locale,auth:query("#auth").textContent,tripo:query("#tripo [role=alert]").textContent,choose:query(".site-page [role=alert]").textContent,site:query(".site-run-body p").textContent,browser:query("#browser [role=alert]").textContent};
      check(sample.auth===language.i18n.t("popupBlocked",{ns:"auth"}),"retained login error");
      check(sample.tripo===tripoErrorMessages("resultUnknown")[locale],"retained Tripo owned invoke error");
      check(sample.choose===language.i18n.t(phase==="native"?"pickerFailed":"directoryDesktopOnly",{ns:phase==="native"?"native":"plugins"}),"retained directory error");
      check(sample.site===(phase==="stop"?siteTranslations[locale].previewNotReady:language.i18n.t(phase==="native"?"previewLocalOnly":phase==="open"?"previewDesktopOnly":"connection_interrupted",{ns:phase==="native"?"native":phase==="open"?"plugins":"apiErrors"})),"retained Site operation error");
      check(sample.browser===language.i18n.t("browserTabLimit",{ns:"native"}),"retained native browser error");
      check(query(".site-fields input")===input&&input.value===draft&&document.activeElement===focusTarget,"draft node value and focus preserved");
      check(query(".site-detail h2").textContent===original,"original project name");
      check(requests.length===calls&&writes===writeCount&&popupAttempts===2&&dirty.length===dirtyCount&&nativeCalls===nativeCount,"no operations or writes on language change");
      check(subscriptions===1&&cleanups===0,"same Site subscription");
      snapshots.push(sample);
    }
  }
  codedAuth=true;await auth.start("device_code");await settle();
  for(const code of ["auth_callback_expired","auth_token_exchange_failed"]){
    if(code==="auth_token_exchange_failed") {statusReply={state:"error",model:"original-model",message:"old status failure",messageDetails:{code}};await auth.refresh();await settle();}
    const calls=requests.length;
    for(const locale of locales){await language.systemChanged([locale]);await settle();check(query("#auth").textContent===language.i18n.t(code,{ns:"apiErrors"}),"retained OAuth status and HTTP diagnosis translate");check(requests.length===calls,"OAuth translation does not restart authorization or polling");}
  }
  cancelPicker=true;
  query(".site-add-project").click();await settle();
  check(!document.querySelector(".site-page [role=alert]"),"explicit picker cancellation clears old error");
  root.unmount();
  check(cleanups===1,"Site subscription released");
  check(nativeCalls===3,"only explicit native acquisition selection and preview");
  check(requests.filter(request=>request.path==="/auth/codex/start").length===2,"only two explicit login attempts");
  check(requests.filter(request=>request.path.endsWith("aura.tripo/invoke")).length===1,"Tripo read once");
  check(requests.filter(request=>request.path.endsWith("site-launcher/invoke")).length===2,"only explicit Site start and stop");
  document.getElementById("result").textContent=JSON.stringify({checks,snapshots});
}
inspect().catch(error=>{document.getElementById("result").textContent=JSON.stringify({error:String(error),checks,requests});});
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
          name: "PublicErrors",
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
    assert.ok(json, "Browser returned public error results");
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
    assert.equal(result.snapshots.length, 24);
    assert.ok(result.checks.length > 210);
    for (const phase of ["start", "stop", "open", "native"])
      for (const field of ["auth", "tripo", "choose", "site", "browser"])
        assert.equal(
          new Set(
            result.snapshots
              .filter((item) => item.phase === phase)
              .map((item) => item[field]),
          ).size,
          6,
          `${phase}: ${field}`,
        );
  },
);
