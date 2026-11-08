import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "local secret masking recovers from asset failure and survives backend failure, replacement and six-language changes",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check local message display in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-local-mask-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(root, "fixture.ts");
    // The only successful script request loads the real published local bundle.
    // The synthetic backend always fails and no account or model is contacted.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {palettes} from ${modulePath("@aura/ui/theme")};
import {MaskedUserText} from ${source("../src/features/coding/MaskedUserText.tsx")};
import {loadSecretMaskClient} from ${source("../src/features/coding/secret-mask-client.ts")};
import {startSecretMask,retrySecretMask,secretMaskStateSnapshot,subscribeSecretMask} from ${source("../src/features/coding/secret-mask.ts")};
import {startPluginHost} from ${source("../src/pluginHost.ts")};
import ${source("../src/styles.css")};
import ${source("../src/features/coding/coding.css")};
let assetRequests=0, backendRequests=0, failAssets=true;
const assetURLs=[], snapshots=[], masks=[];
const append=document.head.append.bind(document.head);
document.head.append=(element)=>{
  if(element.tagName==="SCRIPT"){
    assetRequests++;
    assetURLs.push(element.src);
    if(failAssets){queueMicrotask(()=>element.onerror?.(new Event("error")));return;}
  }
  append(element);
};
globalThis.fetch=async()=>{backendRequests++;return Response.json({message:"Synthetic backend unavailable"},{status:503});};
const mount=document.getElementById("root"),root=createRoot(mount);
const credential="ghp_"+"a".repeat(36);
let prompt="普通消息 hello";
const render=()=>flushSync(()=>root.render(React.createElement(LanguageProvider,null,
  React.createElement("input",{id:"draft",defaultValue:"Unsaved draft 原文"}),
  React.createElement("div",{id:"ordinary"},React.createElement(MaskedUserText,{text:prompt})),
  React.createElement("div",{id:"sensitive"},React.createElement(MaskedUserText,{text:"before "+credential+" after"}))
)));
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
for(const [key,value]of Object.entries(palettes.dark))document.documentElement.style.setProperty("--"+key,value);
async function inspect(){
  await language.systemChanged(["en"]);
  render();
  const loadingVisible=document.querySelector('[aria-busy="true"]')!==null;
  const initial=startSecretMask(loadSecretMaskClient);
  await startPluginHost("https://synthetic.invalid",()=>{}).catch(()=>{});
  await initial;
  await settle();
  const initialFailures=assetRequests;
  const blocked=!mount.textContent.includes(credential)&&!document.getElementById("ordinary").textContent.includes(prompt);
  const draft=document.getElementById("draft");
  draft.focus();
  for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
    await language.systemChanged([locale]);await settle();
    for(const width of [320,360,1100]){
      mount.style.width=width+"px";
      snapshots.push({locale,width,error:document.querySelector('[role="alert"]')?.textContent,overflow:mount.scrollWidth>mount.clientWidth,focused:document.activeElement===draft,draft:draft.value,requests:assetRequests});
    }
  }
  failAssets=false;
  flushSync(()=>document.querySelector('#ordinary button').click());
  await retrySecretMask();await settle();
  const recovered=secretMaskStateSnapshot().phase==="ready";
  const first=secretMaskStateSnapshot().mask;
  const unsub=subscribeSecretMask(()=>masks.push(secretMaskStateSnapshot().mask));
  for(let i=0;i<5;i++){prompt="普通消息 "+i;render();await settle();}
  const beforeReload=assetRequests;
  await startPluginHost("https://synthetic.invalid",()=>{}).catch(()=>{});
  failAssets=true;
  await retrySecretMask();await settle();
  const retained=secretMaskStateSnapshot().mask===first;
  const visible=document.getElementById("ordinary").textContent===prompt;
  const hidden=!document.getElementById("sensitive").textContent.includes(credential);
  const noGap=masks.every(Boolean);
  unsub();
  document.getElementById("result").textContent=JSON.stringify({loadingVisible,initialFailures,blocked,snapshots,recovered,beforeReload,retained,visible,hidden,noGap,assetRequests,assetURLs,backendRequests});
  root.unmount();
}
inspect().catch(error=>{document.getElementById("result").textContent=JSON.stringify({error:String(error)});});
`,
    );
    const output = join(root, "bundle");
    await build({
      configFile: false,
      root,
      base: "./",
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: entry,
          output: {
            format: "iife",
            entryFileNames: "fixture.js",
            assetFileNames: "[name][extname]",
          },
        },
      },
    });
    const cssFiles = (await readdir(output)).filter((name) =>
      name.endsWith(".css"),
    );
    const css = (
      await Promise.all(
        cssFiles.map((name) => readFile(join(output, name), "utf8")),
      )
    ).join("\n");
    const page = join(root, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#root{width:1100px}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script src="./bundle/fixture.js"></script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(root, "chrome")}`,
        "--window-size=1400,900",
        "--virtual-time-budget=10000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "Chromium must return local masking results");
    const result = JSON.parse(json) as {
      error?: string;
      loadingVisible: boolean;
      initialFailures: number;
      blocked: boolean;
      snapshots: Array<{
        locale: string;
        width: number;
        error: string;
        overflow: boolean;
        focused: boolean;
        draft: string;
        requests: number;
      }>;
      recovered: boolean;
      beforeReload: number;
      retained: boolean;
      visible: boolean;
      hidden: boolean;
      noGap: boolean;
      assetRequests: number;
      assetURLs: string[];
      backendRequests: number;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.loadingVisible, true);
    assert.equal(result.initialFailures, 3);
    assert.equal(result.blocked, true);
    assert.equal(result.snapshots.length, 18);
    assert.equal(new Set(result.snapshots.map((item) => item.error)).size, 6);
    for (const item of result.snapshots) {
      assert.equal(item.overflow, false, `${item.locale}/${item.width}`);
      assert.equal(item.focused, true);
      assert.equal(item.draft, "Unsaved draft 原文");
      assert.equal(item.requests, 3);
    }
    assert.equal(result.recovered, true);
    assert.equal(result.beforeReload, 4);
    assert.equal(result.retained, true);
    assert.equal(result.visible, true);
    assert.equal(result.hidden, true);
    assert.equal(result.noGap, true);
    assert.equal(result.assetRequests, 7);
    assert.ok(result.assetURLs.every((url) => url.startsWith("file:")));
    assert.equal(result.backendRequests, 2);
  },
);
