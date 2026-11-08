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
  "conversation settings save without quota fields and retain drafts and focus across six languages and narrow containers",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check conversation settings in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "aura-capability-settings-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Synthetic responses isolate the real settings UI from accounts and models.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {palettes} from ${modulePath("@aura/ui/theme")};
import {ConversationCapabilitySettings} from ${source("../src/screens/ConversationCapabilitySettings.tsx")};
import ${source("../src/styles.css")};
const requests=[], snapshots=[];
const config={revision:7,autoCompact:false,web:true,subagents:true,hasWebKey:true,usedRequests:100,unknownRequests:5};
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname;
  const body=options?.body?JSON.parse(options.body):undefined;
  requests.push({path,method:options?.method??"GET",body});
  if(path!=="/coding/capabilities") throw new Error("Unexpected request: "+path);
  return Response.json(body?{...config,...body,revision:8}:config);
};
const mount=document.getElementById("root"),root=createRoot(mount);
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async(selector)=>{for(let i=0;i<50&&!document.querySelector(selector);i++)await settle();if(!document.querySelector(selector))throw new Error("Missing "+selector);};
for(const [key,value] of Object.entries(palettes.dark))document.documentElement.style.setProperty("--"+key,value);
async function inspect(){
  await language.systemChanged(["en"]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,React.createElement(ConversationCapabilitySettings,{endpoint:"https://synthetic.invalid"}))));
  await waitFor('input[type="password"]');
  const input=document.querySelector('input[type="password"]');
  const switches=[...document.querySelectorAll('[role="switch"]')];
  flushSync(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"synthetic-draft-key");
    input.dispatchEvent(new Event("input",{bubbles:true}));
    switches[0].click();
  });
  input.focus();
  for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
    await language.systemChanged([locale]);
    await settle();
    for(const width of [320,360,1100]){
      mount.style.width=width+"px";
      snapshots.push({locale,width,heading:document.querySelector("h3").textContent,
        draft:input.value,focused:document.activeElement===input,sameInput:document.querySelector('input[type="password"]')===input,
        checked:switches.map(item=>item.checked),reads:requests.length,
        numberFields:document.querySelectorAll('input[type="number"]').length,
        checkboxes:document.querySelectorAll('input[type="checkbox"]').length,
        overflow:mount.scrollWidth>mount.clientWidth,
      });
    }
  }
  flushSync(()=>document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  for(let i=0;i<30&&(requests.length<2||document.querySelector('button[type="submit"]').disabled);i++)await settle();
  document.getElementById("result").textContent=JSON.stringify({snapshots,requests,cleared:input.value==="",feedback:document.querySelector("[aria-live]")?.textContent});
  root.unmount();
}
inspect().catch(error=>{document.getElementById("result").textContent=JSON.stringify({error:String(error)});});
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
          name: "CapabilitySettingsFixture",
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
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#root{container:settings-body / inline-size}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(directory, "chrome")}`,
        "--window-size=1400,900",
        "--virtual-time-budget=5000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "Chromium must return the settings results");
    const result = JSON.parse(json) as {
      error?: string;
      snapshots: Array<{
        locale: string;
        width: number;
        heading: string;
        draft: string;
        focused: boolean;
        sameInput: boolean;
        checked: boolean[];
        reads: number;
        numberFields: number;
        checkboxes: number;
        overflow: boolean;
      }>;
      requests: Array<{ path: string; method: string; body?: unknown }>;
      cleared: boolean;
      feedback: string;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.snapshots.length, 18);
    assert.equal(new Set(result.snapshots.map((item) => item.heading)).size, 6);
    for (const snapshot of result.snapshots) {
      assert.equal(snapshot.draft, "synthetic-draft-key");
      assert.equal(snapshot.focused, true);
      assert.equal(snapshot.sameInput, true);
      assert.deepEqual(snapshot.checked, [true, true, true]);
      assert.equal(snapshot.reads, 1);
      assert.equal(snapshot.numberFields, 0);
      assert.equal(snapshot.checkboxes, 4);
      assert.equal(
        snapshot.overflow,
        false,
        `${snapshot.locale}/${snapshot.width}`,
      );
    }
    assert.deepEqual(
      result.requests.map((item) => item.method),
      ["GET", "POST"],
    );
    assert.deepEqual(result.requests[1]?.body, {
      revision: 7,
      autoCompact: true,
      web: true,
      subagents: true,
      clearKey: false,
      key: "synthetic-draft-key",
    });
    assert.equal(result.cleared, true);
    assert.ok(result.feedback);
  },
);
