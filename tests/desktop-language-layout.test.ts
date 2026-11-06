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
  "desktop startup keeps translated text and reload controls visible at exact narrow and wide viewports",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check desktop startup layouts"
        : false,
    timeout: 40_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-desktop-language-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const entry = join(directory, "fixture.ts");
    await writeFile(
      entry,
      `
import { startDesktopStartup } from ${source("../apps/desktop/src/startup.ts")};
import { desktopCatalogs } from ${source("../apps/desktop/src/desktop-messages.ts")};
import { language, locales, registerCatalogs } from ${modulePath("@aura/i18n/runtime")};
import { pseudolocalize } from ${modulePath("@aura/i18n/catalogs")};
import ${source("../apps/desktop/src/startup.css")};
const checks=[], snapshots=[];
const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
let writes=0, requests=0;
Storage.prototype.setItem=function(){writes++;};
globalThis.fetch=async()=>{requests++;throw new Error("Unexpected request");};
async function inspect(){
  const startup=startDesktopStartup();
  const surface=document.getElementById("desktop-startup");
  const reload=document.getElementById("desktop-startup-reload");
  const message=document.getElementById("desktop-startup-message");
  const canvas=document.getElementById("desktop-startup-field");
  for(const phase of ["loading","failed"]){
    if(phase==="failed") {startup.fail();reload.focus();}
    for(const variant of [...locales,"pseudo"]){
      const locale=variant==="pseudo"?"en":variant;
      const expected=variant==="pseudo"?pseudolocalize(desktopCatalogs.en):desktopCatalogs[locale];
      registerCatalogs("desktop",{...desktopCatalogs,...(variant==="pseudo"?{en:expected}:{})});
      await language.systemChanged([locale]);await settle();
      check(innerWidth===Number(new URL(location.href).searchParams.get("width")),"exact viewport");
      check(document.documentElement.lang===locale,"document language");
      check(message.textContent===expected[phase==="loading"?"startupLoading":"startupFailed"],"message");
      check(document.getElementById("desktop-startup-tagline").textContent===expected.tagline,"tagline");
      check(surface===document.getElementById("desktop-startup")&&canvas===document.getElementById("desktop-startup-field"),"same surface and canvas");
      if(phase==="failed")check(document.activeElement===reload&&!reload.hidden,"reload focus");
      for(const selector of ["#desktop-startup-tagline","#desktop-startup-message",...(phase==="failed"?["#desktop-startup-reload"]:[])]){
        const element=document.querySelector(selector), bounds=element.getBoundingClientRect();
        check(bounds.left>=0&&bounds.right<=innerWidth+1&&bounds.top>=0&&bounds.bottom<=innerHeight,"control bounds "+selector);
        check(element.scrollWidth<=element.clientWidth+1,"text overflow "+selector);
        const range=document.createRange();range.selectNodeContents(element);
        for(const rect of range.getClientRects())check(rect.left>=0&&rect.right<=innerWidth+1,"text visible "+selector);
      }
      snapshots.push({phase,variant,message:message.textContent});
    }
  }
  check(writes===0&&requests===0,"no storage writes or network requests");
  startup.dispose();
  check(!surface.isConnected&&!document.getElementById("root").inert,"released startup");
  parent.postMessage({checks,snapshots,viewport:innerWidth},"*");
}
inspect().catch(error=>parent.postMessage({error:String(error),checks},"*"));
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
          name: "DesktopLanguages",
          fileName: "fixture",
        },
      },
    });
    const [script, css, template] = await Promise.all([
      readFile(join(output, "fixture.iife.js"), "utf8"),
      readFile(join(output, "fixture.css"), "utf8"),
      readFile(new URL("../apps/desktop/index.html", import.meta.url), "utf8"),
    ]);
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      template
        .replace(/<link[^>]+startup\.css[^>]*>/u, () => `<style>${css}</style>`)
        .replace(
          /<script type="module"[^>]+><\/script>/u,
          () =>
            `<script>addEventListener('error',event=>parent.postMessage({error:event.message,checks:[]},'*'));</script><script>${script.replaceAll("</script", "<\\/script")}</script>`,
        ),
    );
    for (const width of [320, 360, 1400]) {
      const host = join(directory, `host-${width}.html`);
      await writeFile(
        host,
        `<!doctype html><html><body><pre id="result"></pre><script>addEventListener('message',event=>document.getElementById('result').textContent=JSON.stringify(event.data));</script><iframe src="${pathToFileURL(page).href}?width=${width}" style="border:0;width:${width}px;height:800px"></iframe></body></html>`,
      );
      const { stdout } = await promisify(execFile)(
        chrome!,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          `--user-data-dir=${join(directory, `browser-${width}`)}`,
          "--window-size=1440,1000",
          "--virtual-time-budget=4000",
          "--dump-dom",
          pathToFileURL(host).href,
        ],
        { timeout: 25_000, maxBuffer: 2_000_000 },
      );
      const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
      assert.ok(json, "Browser returned startup results");
      const result = JSON.parse(
        json
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ) as {
        error?: string;
        viewport: number;
        checks: string[];
        snapshots: unknown[];
      };
      assert.equal(
        result.error,
        undefined,
        `${width}px: ${JSON.stringify(result)}`,
      );
      assert.equal(result.viewport, width);
      assert.equal(result.snapshots.length, 14);
      assert.ok(result.checks.length > 150);
    }
  },
);
