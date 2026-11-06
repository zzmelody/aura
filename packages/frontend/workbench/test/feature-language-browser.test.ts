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
  "language changes retain drafts, local errors, model requests and browser and terminal instances",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check feature languages in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-feature-language-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Synthetic responses never reach an Aura service, account or model.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {palettes} from ${modulePath("@aura/ui/theme")};
import {AutomationScreen, timingLabel} from ${source("../src/screens/Automation.tsx")};
import {IntegrationSettingsPanel} from ${source("../src/screens/IntegrationSettings.tsx")};
import {ChatModelControls} from ${source("../src/screens/ChatModelControls.tsx")};
import {ConversationSearch} from ${source("../src/features/coding/ConversationIntegrations.tsx")};
import {TurnActions} from ${source("../src/features/coding/TurnActions.tsx")};
import {BrowserPane} from ${source("../src/features/coding/BrowserPane.tsx")};
import {TerminalPane} from ${source("../src/features/coding/TerminalPane.tsx")};
const endpoint = "https://synthetic.example";
const requests = [];
let acquired=0, released=0, eventStreams=0, streamCloses=0, navigations=0;
const terminalInfo={id:"terminal",projectId:"project",title:"Original shell",directory:"/synthetic",createdAt:1,status:"running",activity:"idle"};
const onInfo=()=>{};
globalThis.EventSource=class extends EventTarget {
  static CLOSED=2;
  readyState=1;
  constructor(){super();eventStreams++;setTimeout(()=>this.onopen?.(),0);}
  close(){this.readyState=2;streamCloses++;}
};
const createElement=document.createElement.bind(document);
document.createElement=(tag,options)=>{
  const element=createElement(tag,options);
  if(tag==="webview") {
    Object.assign(element,{canGoBack:()=>false,canGoForward:()=>false,getURL:()=>"about:blank",getTitle:()=>"",goBack(){},goForward(){},reload(){navigations++;}});
    setTimeout(()=>element.dispatchEvent(new Event("dom-ready")),0);
  }
  return element;
};
const browserHost={acquire:async()=>{acquired++;return {lease:"test-lease",partition:"synthetic"};},release:async()=>{released++;},navigate:async()=>{navigations++;},openExternal:async()=>{navigations++;}};
const onPage=()=>{throw new Error("Language changes must not save a browser page");};
globalThis.fetch = async (input, options) => {
  const path = new URL(String(input)).pathname;
  requests.push({path,method:options?.method ?? "GET"});
  if(path === "/coding/automation") return Response.json([]);
  if(path === "/integrations/settings") return Response.json({revision:1, flags:{mcp:true, voice:true}, mcpServers:[], voicePhase:"unprepared"});
  if(path === "/chat/models") return Response.json({mode:"codex",defaultModel:"synthetic",models:[{id:"synthetic",name:"My Model",reasoningEfforts:[{id:"high",name:"High"}],defaultReasoningEffort:"high"}]});
  if(path === "/integrations/search") return Response.json({message:"legacy readable message",code:"integration_unavailable"},{status:503});
  if(path.endsWith("/resize")) return Response.json(terminalInfo);
  throw new Error("Unexpected synthetic request: " + path);
};
const rootNode = document.getElementById("root");
const root = createRoot(rootNode);
const conversations = {projects:[{id:"project",title:"User workspace"}],conversations:{project:[{id:"session",title:"用户原文 / original text"}]}};
const snapshots = [];
const edit = (input,value) => flushSync(() => {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value").set.call(input,value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input",{bubbles:true}));
});
const click = selector => flushSync(() => document.querySelector(selector).click());
const settle = async () => { await new Promise(resolve => setTimeout(resolve,0)); flushSync(() => {}); };
const waitFor = async selector => { for(let i=0;i<40 && !document.querySelector(selector);i++) await settle(); if(!document.querySelector(selector)) throw new Error("Missing " + selector); };
for(const [key,value] of Object.entries(palettes.dark)) document.documentElement.style.setProperty("--"+key,value);
async function inspect() {
  await language.systemChanged(["zh-CN"]);
  flushSync(() => root.render(React.createElement(LanguageProvider,null,
    React.createElement("div",{id:"integrations"},React.createElement(IntegrationSettingsPanel,{endpoint})),
    React.createElement("div",{id:"automation"},React.createElement(AutomationScreen,{endpoint,conversations,openConversation(){}})),
    React.createElement("div",{id:"models"},React.createElement(ChatModelControls,{endpoint,mode:"codex",selection:{},disabled:false,onChange(){}})),
    React.createElement(ConversationSearch,{endpoint,projectId:"project",open(){}}),
    React.createElement(TurnActions,{reply:"Original reply 原文",endedAt:Date.UTC(2026,0,5,12),usage:{totalTokens:12500,outputTokens:2500,cacheReadTokens:7500}}),
    React.createElement(BrowserPane,{id:"browser",workspace:"project",visible:true,host:browserHost,onPage}),
    React.createElement("div",{style:{display:"flex",height:200}},React.createElement(TerminalPane,{endpoint,info:terminalInfo,visible:true,onInfo}))
  )));
  await waitFor('#integrations input[name="name"]');
  await waitFor('.chat-model-name');
  await waitFor('.xterm');
  for(let i=0;i<10;i++) await settle();
  const serverName=document.querySelector('#integrations input[name="name"]');
  edit(serverName,"Unsaved server 原文");
  const browser=document.querySelector('.coding-browser input');
  const terminal=document.querySelector('.xterm');
  edit(browser,"invalid://draft");
  flushSync(()=>document.querySelector('.coding-browser form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  edit(document.querySelector('#integrations select'),"stdio");
  edit(document.querySelector('#integrations input[name="args"]'),"invalid JSON");
  flushSync(() => document.querySelector('#integrations form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  const search=document.querySelector('.conversation-search input');
  edit(search,"用户查询 / original query");
  flushSync(() => document.querySelector('.conversation-search form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  await waitFor('.conversation-search [role="alert"]');
  click('.chat-model-trigger');
  click('.coding-usage-trigger');
  click('#automation .dsh-button.primary');
  await waitFor('.automation-dialog[open]');
  const name=document.querySelector('.automation-dialog input[maxlength="120"]');
  edit(name,"Unsaved task 原文");
  const weekly=[...document.querySelectorAll('.automation-dialog fieldset button')].find(button=>button.textContent==="每周");
  flushSync(()=>weekly.click());
  for(const day of [...document.querySelectorAll('.automation-weekdays [aria-pressed="true"]')]) flushSync(()=>day.click());
  flushSync(() => document.querySelector('.automation-dialog form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  const reads=()=>JSON.stringify(requests.filter(request=>!request.path.endsWith("/resize")));
  const before = reads();
  for(const width of [1120,360,320]) {
    rootNode.style.width=width+"px";
    for(const locale of ["zh-CN","en","ja","ko","ru","fr"]) {
      await language.systemChanged([locale]);
      await settle();
      const form=document.querySelector('.automation-dialog');
      snapshots.push({locale,width,
        title:document.getElementById('automation-title').textContent,
        taskDraft:name.value,serverDraft:serverName.value,searchDraft:search.value,
        sameName:document.querySelector('.automation-dialog input[maxlength="120"]')===name,
        sameServer:document.querySelector('#integrations input[name="name"]')===serverName,
        error:form.querySelector('[role="alert"]').textContent,
        serverError:document.querySelector('#integrations [role="alert"]').textContent,
        searchError:document.querySelector('.conversation-search [role="alert"]').textContent,
        effort:document.querySelector('.chat-model-effort').textContent,
        model:document.querySelector('.chat-model-name').textContent,
        usage:document.querySelector('.coding-usage-trigger').getAttribute('aria-label'),
        day:document.querySelector('.automation-weekdays button').getAttribute('aria-label'),
        weekly:timingLabel({kind:'weekly',weekdays:[1,5],time:'09:00:00',timeZone:'Asia/Shanghai'}),
        interval:timingLabel({kind:'every',everySeconds:7200}),
        browserDraft:browser.value,
        browserError:document.querySelector('.coding-browser [role="alert"]').textContent,
        guestLabel:document.querySelector('webview').getAttribute('aria-label'),
        terminalLabel:document.querySelector('.coding-terminal-screen').getAttribute('aria-label'),
        sameTerminal:document.querySelector('.xterm')===terminal,
        sameBrowser:document.querySelector('.coding-browser input')===browser,
        acquired,eventStreams,streamCloses,navigations,
        noWrites:requests.every(request=>request.method==='GET'||request.path.endsWith("/resize")),
        unchangedRequests:reads()===before,
        overflow:['integrations','automation','models'].filter(id=>{const el=document.getElementById(id);return el.scrollWidth>el.clientWidth+1;}),
        dialogOverflow:form.scrollWidth>form.clientWidth+1,
      });
    }
  }
  root.unmount();
  await settle();
  document.getElementById('result').textContent=JSON.stringify({snapshots,requests,released,streamCloses});
}
inspect().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error?.stack,requests}));
document.currentScript.remove();
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
          name: "FeaturesFixture",
          fileName: "fixture",
        },
      },
    });
    const [script, css] = await Promise.all([
      readFile(join(output, "fixture.iife.js"), "utf8"),
      readFile(join(output, "fixture.css"), "utf8"),
    ]);
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#root{width:1120px;container:workspace / inline-size}#root>div{min-width:0}#automation{height:500px;display:flex}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
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
      { timeout: 30_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "The browser returned feature language results");
    const result = JSON.parse(json) as {
      error?: string;
      requests: Array<{ path: string; method: string }>;
      released: number;
      streamCloses: number;
      snapshots: Array<{
        locale: string;
        width: number;
        title: string;
        taskDraft: string;
        serverDraft: string;
        searchDraft: string;
        sameName: boolean;
        sameServer: boolean;
        error: string;
        serverError: string;
        searchError: string;
        effort: string;
        model: string;
        usage: string;
        day: string;
        weekly: string;
        interval: string;
        noWrites: boolean;
        unchangedRequests: boolean;
        overflow: string[];
        dialogOverflow: boolean;
        browserDraft: string;
        browserError: string;
        guestLabel: string;
        terminalLabel: string;
        sameTerminal: boolean;
        sameBrowser: boolean;
        acquired: number;
        eventStreams: number;
        streamCloses: number;
        navigations: number;
      }>;
    };
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.snapshots.length, 18);
    for (const snapshot of result.snapshots) {
      const label = `${snapshot.locale} at ${snapshot.width}px`;
      assert.equal(snapshot.taskDraft, "Unsaved task 原文", label);
      assert.equal(snapshot.serverDraft, "Unsaved server 原文", label);
      assert.equal(snapshot.searchDraft, "用户查询 / original query", label);
      assert.equal(snapshot.model, "My Model", label);
      assert.equal(snapshot.sameName, true, label);
      assert.equal(snapshot.sameServer, true, label);
      assert.equal(snapshot.noWrites, true, label);
      assert.equal(snapshot.unchangedRequests, true, label);
      assert.deepEqual(snapshot.overflow, [], label);
      assert.equal(snapshot.dialogOverflow, false, label);
      assert.equal(snapshot.browserDraft, "invalid://draft", label);
      assert.equal(snapshot.sameTerminal, true, label);
      assert.equal(snapshot.sameBrowser, true, label);
      assert.equal(snapshot.acquired, 1, label);
      assert.equal(snapshot.eventStreams, 1, label);
      assert.equal(snapshot.streamCloses, 0, label);
      assert.equal(snapshot.navigations, 0, label);
    }
    for (const field of [
      "title",
      "error",
      "serverError",
      "searchError",
      "usage",
      "day",
      "weekly",
      "interval",
      "browserError",
      "guestLabel",
      "terminalLabel",
    ] as const)
      assert.equal(
        new Set(result.snapshots.map((item) => item[field])).size,
        6,
        `${field} translates to all six languages`,
      );
    const efforts: Record<string, string> = {
      "zh-CN": "高",
      en: "High",
      ja: "高",
      ko: "높음",
      ru: "Высокая",
      fr: "Élevé",
    };
    for (const snapshot of result.snapshots)
      assert.equal(snapshot.effort, efforts[snapshot.locale]);
    assert.equal(result.released, 1);
    assert.equal(result.streamCloses, 1);
    assert.equal(
      result.requests.filter((request) => request.path === "/chat/models")
        .length,
      1,
    );
    assert.equal(
      result.requests.filter((request) => request.path === "/coding/automation")
        .length,
      1,
    );
    assert.ok(
      result.snapshots
        .find((item) => item.locale === "en")
        ?.weekly.includes("Mon"),
    );
    assert.ok(
      result.snapshots
        .find((item) => item.locale === "ru")
        ?.interval.includes("2 часа"),
    );
  },
);
