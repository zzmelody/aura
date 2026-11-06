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
  "language changes preserve active resizes, selected text and cached plugin failures",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check peripheral controls in Chromium"
        : false,
    timeout: 40_000,
  },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "aura-peripheral-language-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Real UI and plugin host with synthetic HTTP failures; no live Aura service.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language, MessageError} from ${modulePath("@aura/i18n/runtime")};
import {palettes, fontStacks} from ${modulePath("@aura/ui/theme")};
import {ResizableSidebar} from ${source("../src/ResizableSidebar.tsx")};
import {ConversationSplit} from ${source("../src/features/coding/ConversationSplit.tsx")};
import {SelectionActions} from ${source("../src/features/coding/SelectionActions.tsx")};
import {useConversationMessages} from ${source("../src/conversation-messages.ts")};
import {PluginPageBoundary} from ${source("../src/PluginPageBoundary.tsx")};
import {pluginMessage} from ${source("../src/plugin-messages.ts")};
import {usePluginPages} from ${source("../src/usePluginPages.ts")};
import {PluginDirectorySettings} from ${source("../src/screens/PluginDirectorySettings.tsx")};
import {PluginList} from ${source("../src/screens/Plugins.tsx")};
import ${source("../src/styles.css")};
import ${source("../src/workspace-chrome.css")};
import ${source("../src/features/coding/coding.css")};
const requests=[], saved=[], quotes=[], checks=[], snapshots=[];
// Chromium's virtual-time dump can stop producing frames while timers advance.
// Drive the real frame callbacks with its virtual clock; layout remains native.
globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),16);
globalThis.cancelAnimationFrame=id=>clearTimeout(id);
const attempts={unknown:0,external:0,local:0};
const original="原始文本 / Original text";
const storageKey="aura.coding.side-width";
localStorage.setItem(storageKey,"400");
const setItem=Storage.prototype.setItem,removeItem=Storage.prototype.removeItem;
let widthWrites=0;
Storage.prototype.setItem=function(key,value){if(key===storageKey)widthWrites++;return setItem.call(this,key,value);};
Storage.prototype.removeItem=function(key){if(key===storageKey)widthWrites++;return removeItem.call(this,key);};
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname;
  requests.push({path,method:options?.method??"GET"});
  if(path==="/plugins/graph"||path==="/plugins/config") return new Response("unavailable",{status:503});
  throw new Error("Unexpected synthetic request: "+path);
};
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const query=selector=>{const element=document.querySelector(selector);if(!element)throw new Error("Missing "+selector);return element;};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,40));flushSync(()=>{});};
const pointer=(element,type,x)=>flushSync(()=>element.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0,buttons:1,pointerType:"mouse",clientX:x})));
const key=(element,value)=>flushSync(()=>element.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:value})));
const endpoints="https://synthetic.invalid";
function Broken({kind}) {attempts[kind]++;throw kind==="unknown"?null:kind==="external"?new Error(original):new MessageError(pluginMessage("duplicatePage",{id:"example/page"}));}
function HostStatus(){const {failures}=usePluginPages(endpoints,true);return React.createElement("output",{id:"host-failure"},failures[0]?.message??"");}
function Fixture(){
  const [width,setWidth]=React.useState(280),selectionRoot=React.useRef(null),{t}=useConversationMessages();
  return React.createElement(React.Fragment,null,
    React.createElement("div",{id:"desktop-controls"},
      React.createElement(ResizableSidebar,{collapsed:false,width,viewport:1400,onResize:value=>{saved.push(value);setWidth(value);}},React.createElement("span",null,"Sidebar content")),
      React.createElement(ConversationSplit,{main:React.createElement("textarea",{id:"main-draft",defaultValue:original}),side:React.createElement("input",{id:"side-draft",defaultValue:original}),sideHeader:React.createElement("span",null,"Original tool title")})
    ),
    React.createElement("div",{ref:selectionRoot,id:"selection-root"},
      React.createElement("p",{className:"coding-transcript"},React.createElement("span",{id:"selected"},original)),
      React.createElement(SelectionActions,{root:selectionRoot,actions:[
        {id:"main",label:t("quoteMain"),icon:null,run:quote=>quotes.push(quote)},
        {id:"side",label:t("quoteSide"),icon:null,run:quote=>quotes.push(quote)},
      ]})
    ),
    React.createElement("section",{id:"errors"},
      ...["unknown","external","local"].map(kind=>React.createElement("div",{id:kind,key:kind},React.createElement(PluginPageBoundary,{label:"Original plugin",renderPage:()=>React.createElement(Broken,{kind})}))),
      React.createElement(HostStatus),
      React.createElement("div",{id:"directories"},React.createElement(PluginDirectorySettings,{endpoint:endpoints})),
      React.createElement("div",{id:"plugin-list"},React.createElement(PluginList,{endpoint:endpoints,settingsPages:new Map(),onOpenSettings(){}}))
    )
  );
}
for(const [name,value] of Object.entries(palettes.dark))document.documentElement.style.setProperty("--"+name,value);
document.documentElement.style.setProperty("--font-text",fontStacks.system);
document.documentElement.style.setProperty("--font-mono",fontStacks.mono);
const root=createRoot(document.getElementById("root"));
async function inspect(){
  await language.systemChanged(["zh-CN"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(Fixture))));
  for(let i=0;i<30&&!document.getElementById("host-failure").textContent;i++)await settle();
  check(query("#host-failure").textContent.includes("503"),"host failure appears");
  const sidebar=query(".sidebar-resize-handle"),split=query(".coding-split-handle");
  // Synthetic pointer events have no native capture session; actual drag logic runs.
  for(const element of [sidebar,split])element.setPointerCapture=()=>{};
  const main=query("#main-draft"),side=query("#side-draft");
  pointer(sidebar,"pointerdown",280);pointer(sidebar,"pointermove",340);
  pointer(split,"pointerdown",600);pointer(split,"pointermove",540);
  await settle();
  const range=document.createRange();range.selectNodeContents(query("#selected"));
  window.getSelection().removeAllRanges();window.getSelection().addRange(range);
  query("#selected").dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));
  await settle();
  const toolbar=query(".selection-actions"),requestCount=requests.length,renderAttempts=JSON.stringify(attempts);
  toolbar.querySelector("button").focus();
  const focused=document.activeElement;
  for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
    await language.select(locale);await settle();
    check(query(".sidebar-resize-handle")===sidebar&&query(".coding-split-handle")===split,"same resize handles "+locale);
    check(query(".resizable-sidebar").style.getPropertyValue("--sidebar-width")==="340px","sidebar transient width "+locale+": "+query(".resizable-sidebar").style.getPropertyValue("--sidebar-width"));
    check(sidebar.getAttribute("aria-valuenow")==="340"&&sidebar.getAttribute("aria-valuetext").includes("340"),"sidebar announced width "+locale);
    check(split.getAttribute("aria-valuenow")==="460"&&split.getAttribute("aria-valuetext").includes("460"),"split transient width "+locale+": "+split.getAttribute("aria-valuenow"));
    check(query(".resizable-sidebar").dataset.resizing==="true"&&query(".coding-panes").dataset.resizing==="true","drag active "+locale);
    check(saved.length===0&&widthWrites===0&&localStorage.getItem(storageKey)==="400","no width commits "+locale);
    check(query("#main-draft")===main&&query("#side-draft")===side&&main.value===original&&side.value===original,"drafts retained "+locale);
    check(query(".selection-actions")===toolbar&&toolbar.matches(":popover-open"),"same open toolbar "+locale);
    check(window.getSelection().toString()===original&&document.activeElement===focused,"selection and focus retained "+locale);
    const bounds=toolbar.getBoundingClientRect();
    check(bounds.left>=7&&bounds.right<=innerWidth-7&&bounds.top>=7&&bounds.bottom<=innerHeight-7,"toolbar in viewport "+locale+": "+JSON.stringify(bounds));
    check(requests.length===requestCount&&JSON.stringify(attempts)===renderAttempts,"no reload or render retry "+locale);
    check(query("#external [role=alert]").textContent.includes(original),"external error unchanged "+locale);
    check(query("#local [role=alert]").textContent.includes("example/page"),"plugin ID unchanged "+locale);
    snapshots.push({locale,sidebar:sidebar.getAttribute("aria-label"),split:split.getAttribute("aria-label"),panel:query(".coding-side").getAttribute("aria-label"),selection:toolbar.getAttribute("aria-label"),unknown:query("#unknown [role=alert]").textContent,local:query("#local [role=alert]").textContent,host:query("#host-failure").textContent,directories:query("#directories [role=alert]").textContent,list:query("#plugin-list [role=alert]").textContent});
  }
  // A queued animation frame must also use the new language and current width.
  pointer(sidebar,"pointermove",360);await language.select("ja");await settle();
  check(sidebar.getAttribute("aria-valuetext")==="360 ピクセル","pending frame uses current locale");
  pointer(sidebar,"pointercancel",360);pointer(split,"pointercancel",540);await settle();
  check(saved.length===0&&widthWrites===0,"cancel does not commit");
  check(sidebar.getAttribute("aria-valuenow")==="280"&&split.getAttribute("aria-valuenow")==="400","cancel restores initial widths");
  key(sidebar,"ArrowRight");key(split,"ArrowLeft");await settle();
  check(JSON.stringify(saved)==="[296]"&&widthWrites===1&&localStorage.getItem(storageKey)==="416","keyboard commits once");
  pointer(sidebar,"pointerdown",296);pointer(sidebar,"pointermove",356);
  pointer(split,"pointerdown",600);pointer(split,"pointermove",540);
  await language.select("ru");await settle();
  pointer(sidebar,"pointerup",356);pointer(split,"pointerup",540);await settle();
  check(JSON.stringify(saved)==="[296,356]"&&widthWrites===2&&localStorage.getItem(storageKey)==="476","pointer release commits once");
  flushSync(()=>toolbar.querySelector("button").click());
  check(quotes.length===1&&quotes[0]==="> "+original+"\\n\\n","quote preserves original text");
  check(!document.querySelector(".selection-actions"),"quote dismisses toolbar");
  check(requests.length===requestCount,"no extra plugin requests");
  flushSync(()=>root.unmount());
  return {checks,snapshots,requests,viewport:innerWidth};
}
const publish=result=>{document.getElementById("result").textContent=JSON.stringify(result);parent.postMessage(result,"*");};
inspect().then(publish).catch(error=>publish({error:error.stack??String(error),checks}));
`,
    );
    const output = join(directory, "dist");
    await build({
      configFile: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      esbuild: { jsx: "automatic" },
      build: {
        outDir: output,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry,
          formats: ["iife"],
          name: "PeripheralFixture",
          fileName: "fixture",
        },
      },
    });
    const css = await readFile(join(output, "fixture.css"), "utf8");
    const script = await readFile(join(output, "fixture.iife.js"), "utf8");
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;font-family:var(--font-text)}#root{overflow:hidden;--workspace-sidebar-progress:1}
#desktop-controls{position:fixed;left:0;top:0;width:1120px;height:120px;display:flex}.coding-panes{width:840px;flex:none}#main-draft{min-width:0;flex:1}
#selection-root{position:fixed;right:8px;top:170px}.coding-transcript{margin:0}#errors{height:200px;overflow:auto;margin-top:180px}
</style></head><body><div id="root" class="aura-root"></div><pre id="result"></pre><script>addEventListener('error',event=>parent.postMessage({error:event.error?.stack??event.message,checks:[]},'*'));</script><script>document.currentScript.remove();${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    for (const width of [1400, 360, 320]) {
      // A frame gives an exact viewport even when the native browser window has
      // a platform minimum width larger than the requested mobile size.
      const host = join(directory, `host-${width}.html`);
      await writeFile(
        host,
        `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="result"></pre><script>addEventListener('message',event=>document.getElementById('result').textContent=JSON.stringify(event.data));</script><iframe src="${pathToFileURL(page).href}" style="border:0;width:${width}px;height:1000px"></iframe></body></html>`,
      );
      const { stdout } = await promisify(execFile)(
        chrome!,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          `--user-data-dir=${join(directory, `browser-${width}`)}`,
          "--window-size=1440,1100",
          "--virtual-time-budget=8000",
          "--dump-dom",
          pathToFileURL(host).href,
        ],
        { timeout: 25_000, maxBuffer: 2_000_000 },
      );
      const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
      assert.ok(json, "The browser returned peripheral language results");
      const result = JSON.parse(
        json
          .replaceAll("&nbsp;", "\u00a0")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ) as {
        error?: string;
        viewport: number;
        checks: string[];
        snapshots: Array<Record<string, string>>;
        requests: Array<{ path: string; method: string }>;
      };
      assert.equal(
        result.error,
        undefined,
        `${width}px: ${JSON.stringify(result)}`,
      );
      assert.equal(result.viewport, width);
      assert.ok(result.checks.length > 70);
      assert.equal(result.snapshots.length, 6);
      for (const field of [
        "sidebar",
        "split",
        "panel",
        "selection",
        "unknown",
        "local",
        "host",
        "directories",
        "list",
      ])
        assert.equal(
          new Set(result.snapshots.map((item) => item[field])).size,
          6,
          `${field} at ${width}px`,
        );
      assert.equal(result.requests.length, 3);
      assert.ok(result.requests.every((request) => request.method === "GET"));
    }
  },
);
