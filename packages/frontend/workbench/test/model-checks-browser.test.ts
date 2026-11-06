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
  "model checks retain translated results, original drafts and request counts across six languages",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check model service feedback"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-model-checks-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Real model settings and transport; every HTTP response is synthetic, with no paid requests.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};

import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language,locales,messageText} from ${modulePath("@aura/i18n/runtime")};
import {ModelServiceSettings} from ${source("../src/screens/ModelServiceSettings.tsx")};
import {modelServiceFeedback,modelServiceMessage} from ${source("../src/model-service-messages.ts")};
const endpoint="https://synthetic.invalid",requests=[],checks=[],snapshots=[];
const model={mode:"custom",model:"original-model",reasoningEffort:"off",hasKey:true,configured:true,custom:{name:"Original service",baseURL:"https://gateway.invalid/v1",api:"openai-completions",images:false,contextWindow:65536}};
const state={model,customModel:model,lumina:{model:"original-lumina",reasoningEffort:"off",baseURL:"https://lumina.invalid/v1",hasKey:true,readOnly:false,modelCount:2},checks:{model:"legacy model result",lumina:"legacy Lumina result"},checkDetails:{model:{code:"unchecked"},lumina:{code:"unchecked"}}};
let failHttp=false,writes=0;
const setItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){writes++;return setItem.call(this,key,value);};
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const query=selector=>{const element=document.querySelector(selector);if(!element)throw new Error("Missing "+selector);return element;};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async predicate=>{for(let i=0;i<60&&!predicate();i++)await settle();check(predicate(),"wait completed");};
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname;
  requests.push({path,method:options?.method??"GET",body:options?.body?JSON.parse(options.body):undefined});
  if(path.includes("capabilities"))return Response.json({message:"synthetic unavailable"},{status:503});
  if(path.startsWith("/ai/services"))return failHttp&&options?.method==="POST"?Response.json({}, {status:503}):Response.json(state);
  throw new Error("Unexpected synthetic request "+path);
};
const root=createRoot(document.getElementById("root"));
async function inspect(){
  await language.systemChanged(["en"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(ModelServiceSettings,{endpoint,onUse:()=>{throw new Error("Unexpected provider selection");}}))));
  await waitFor(()=>document.querySelector("input[inputmode=url]")?.value===model.custom.baseURL);
  const form=query("input[inputmode=url]").closest("form"),name=form.querySelector("input"),lumina=query('input[aria-label="Lumina API Key"]').closest(".settings-group");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(name,"用户草稿 / Unsaved service");name.dispatchEvent(new Event("input",{bubbles:true}));await settle();
  const sync=lumina.querySelector(".settings-actions button");
  for(const [phase,detail] of [
    ["success",{code:"probe_succeeded",model:"original-model",elapsedMs:1234,reply:"原始回复 / OK"}],
    ["failure",{code:"probe_failed",model:"original-model",reason:"authentication"}],
    ["legacy",undefined],
    ["http",undefined],
  ]){
    state.checkDetails.model=detail;failHttp=phase==="http";
    state.checkDetails.lumina=phase==="success"?{code:"models_synced",count:2}:{code:"discovery_failed"};
    flushSync(()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await waitFor(()=>form.querySelector(".settings-feedback")&&!form.querySelector("button[type=submit]")?.disabled);
    if(!failHttp){flushSync(()=>sync.click());await waitFor(()=>lumina.querySelector(".settings-feedback")&&!sync.disabled);}
    name.focus();const calls=requests.length,writeCount=writes;
    for(const locale of locales){
      await language.systemChanged([locale]);await settle();
      const expected=phase==="http"?messageText(modelServiceMessage("settingsUnavailable",{status:503})):language.i18n.t("savedCheck",{ns:"settingsDetails",result:messageText(modelServiceFeedback(detail,state.checks.model).text)});
      const feedback=form.querySelector(".settings-feedback");
      check(feedback.textContent===expected,"retained check text follows language");
      check(feedback.classList.contains(phase==="success"?"ok":"error"),"semantic check tone");
      if(!failHttp)check(lumina.querySelector(".settings-feedback").textContent===messageText(modelServiceFeedback(state.checkDetails.lumina,state.checks.lumina).text),"retained discovery result follows language");
      check(form.querySelector("input")===name&&name.value==="用户草稿 / Unsaved service"&&document.activeElement===name,"same unsaved draft and focus");
      check(requests.length===calls&&writes===writeCount,"no requests or writes on language change");
      if(phase==="success")check(feedback.textContent.includes("original-model")&&feedback.textContent.includes("原始回复 / OK"),"original model and generated reply");
      snapshots.push({phase,locale,text:feedback.textContent});
    }
  }
  const saves=requests.filter(request=>request.path==="/ai/services/model");
  check(saves.length===4&&saves.every(request=>request.body.model==="original-model"&&request.body.custom.name==="用户草稿 / Unsaved service"),"only explicit saves submit original values");
  check(requests.filter(request=>request.path==="/ai/services/check/model").length===3,"only explicit successful saves start a model check");
  check(requests.filter(request=>request.path==="/ai/services/check/lumina").length===3,"only explicit discovery checks");
  root.unmount();
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
          name: "ModelChecks",
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
    assert.ok(json, "Browser returned model check results");
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
    assert.ok(result.checks.length > 65);
    for (const phase of ["success", "failure", "http"])
      assert.equal(
        new Set(
          result.snapshots
            .filter((item) => item.phase === phase)
            .map((item) => item.text),
        ).size,
        6,
        phase,
      );
  },
);
