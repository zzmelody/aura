import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "the child catalog separates read errors, retains cached results and retries only reads",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check the child catalog in Chrome"
        : false,
    timeout: 45_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-subagent-ui-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const component = fileURLToPath(
      new URL("../src/features/coding/SubagentPanel.tsx", import.meta.url),
    ).replaceAll("\\", "/");
    const fixture = `
    import React, {useCallback,useRef,useState} from "react";
    import { createRoot } from "react-dom/client";
    import { language } from "/@fs/${fileURLToPath(import.meta.resolve("@aura/i18n/runtime")).replaceAll("\\", "/")}";
    import { SubagentPanel } from "/@fs/${component}";
    import { WorkbenchMenu } from "/@fs/${fileURLToPath(new URL("../src/WorkbenchMenu.tsx", import.meta.url)).replaceAll("\\", "/")}";
    import { ConversationSearch } from "/@fs/${fileURLToPath(new URL("../src/features/coding/ConversationIntegrations.tsx", import.meta.url)).replaceAll("\\", "/")}";
    import "/@fs/${fileURLToPath(new URL("../src/styles.css", import.meta.url)).replaceAll("\\", "/")}";
    import "/@fs/${fileURLToPath(new URL("../src/features/coding/coding.css", import.meta.url)).replaceAll("\\", "/")}";
    let mode = "complete";
    let pending = false;
    let aborts = 0;
    let opened;
    const requests = [];
    const initial = {id:"child",label:"检查目录",role:"只读调研",status:"complete",result:"**已读取的结果**",durationMs:1234};
    window.fetch = async (url, options = {}) => {
      requests.push({url:String(url),method:options.method ?? "GET"});
      if (String(url).includes("/integrations/search?"))return Response.json([{id:"found",title:"已匹配的对话",snippet:"匹配正文"}]);
      if (mode === "hang") {
        pending = true;
        return new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>{
          aborts++; reject(new DOMException("Aborted","AbortError"));
        },{once:true}));
      }
      if (mode === "list-error") return Response.json({}, {status:503});
      const item = mode === "read-error" ? {...initial,status:"unknown",role:"子 Agent",result:"",recordError:"执行结果尚无法确认。"}
        : mode === "execution-error" ? {...initial,status:"error",result:"",executionError:"安全的执行失败提示。"}
        : mode === "localized-error" ? {...initial,label:"子 Agent",defaultLabel:true,roleKind:"research",status:"error",result:"",executionError:"legacy failure",executionErrorDetails:{code:"model_http_failed",params:{status:429,token:"private"}}}
        : mode === "localized-model" ? {...initial,label:"子 Agent",defaultLabel:true,roleKind:"research",status:"error",result:"",executionError:"legacy failure",executionErrorDetails:{code:"model_codex_unsupported",params:{model:"model-"+"x".repeat(70)}}}
        : mode === "localized-read-error" ? {...initial,label:"子 Agent",defaultLabel:true,roleKind:"agent",status:"unknown",result:"",recordError:"legacy read failure",recordErrorDetails:{code:"subagent_record_unavailable",params:{token:"private"}}}
        : mode === "running" ? {...initial,status:"running",result:""} : initial;
      return Response.json([item]);
    };
    const wait = async (predicate) => {
      for (let i=0;i<400;i++) { if(predicate())return; await new Promise(r=>setTimeout(r,10)); }
      throw new Error("timed out: " + document.body.innerText);
    };
    const button = label => [...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")===label);
    const refresh = async next => {
      const before=requests.length;
      mode=next; button("重新读取子 Agent 记录").click();
      await wait(()=>requests.length>before&&!button("重新读取子 Agent 记录").disabled);
    };
    const checks=[];
    const check=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label)};
    const root = createRoot(document.getElementById("root"));
    function Harness() {
      const anchor=useRef(null);
      const [open,setOpen]=useState(false);
      const [search,setSearch]=useState(false);
      const close=useCallback(()=>setOpen(false),[]);
      return <div className="workbench" style={{"--input":"rgb(35, 35, 36)","--text":"rgb(234, 235, 238)","--hairline":"rgba(255,255,255,.12)","--muted":"rgb(166,170,178)"}}><WorkbenchMenu label="对话菜单" items={[{id:"subagents",label:"子 Agent",action:()=>{anchor.current=document.activeElement;setOpen(true)}}]}>…</WorkbenchMenu><SubagentPanel endpoint="http://synthetic.invalid" sessionId="parent" running={false} open={open} anchor={anchor} onClose={close}/><button aria-label="打开搜索" onClick={()=>setSearch(true)}>搜索</button>{search ? <ConversationSearch endpoint="http://synthetic.invalid" projectId="project" open={id=>opened=id} onClose={()=>setSearch(false)}/> : null}</div>;
    }
    await language.systemChanged(["zh-CN"]);
    root.render(<Harness/>);
    const openCatalog=async()=>{
      button("对话菜单").click();
      await wait(()=>document.querySelector('[role="menuitem"]'));
      document.querySelector('[role="menuitem"]').click();
      await wait(()=>document.querySelector('[role="dialog"]'));
    };
    (async()=>{
      await wait(()=>button("对话菜单"));
      check(!document.querySelector(".coding-agents-trigger"),"no standalone child-agent row is rendered");
      await openCatalog();
      await wait(()=>document.querySelector(".coding-agent-row"));
      document.querySelector(".coding-agent-row").click();
      await wait(()=>document.querySelector(".workflow-rich-text strong"));
      check(document.querySelector(".workflow-rich-text strong").textContent==="已读取的结果","Markdown result renders");
      await refresh("read-error");
      await wait(()=>document.body.innerText.includes("记录读取失败"));
      check(document.body.innerText.includes("状态待确认"),"read error keeps the outcome unknown");
      check(!document.body.innerText.includes("执行失败"),"read error is not an execution failure");
      check(document.querySelector(".workflow-rich-text").textContent.includes("已读取的结果"),"cached result survives a read failure");
      check(document.body.innerText.includes("以下为上次读取的结果"),"cached result is marked stale");
      const selected=document.querySelector('.coding-agents-detail');
      const beforeLanguages=requests.length;
      const localized=[];
      for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
        await language.systemChanged([locale]);
        await wait(()=>document.querySelector('.coding-agent-meta').textContent.includes(language.i18n.t('agentUnknown',{ns:'tools'})));
        localized.push({state:document.querySelector('.coding-agent-meta').textContent, warning:document.querySelector('.coding-agent-read-error').textContent,
          retained:document.querySelector('.coding-agents-detail')===selected&&document.querySelector('.workflow-rich-text').textContent.includes('已读取的结果')&&document.querySelector('.coding-agent-meta').textContent.includes('只读调研')});
      }
      check(localized.every(item=>item.retained),"language changes retain the selected child and cached user content");
      check(new Set(localized.map(item=>item.state)).size===6&&new Set(localized.map(item=>item.warning)).size===6,"child status and record warning translate in six languages");
      check(requests.length===beforeLanguages,"language changes do not restart child polling");
      await language.systemChanged(["zh-CN"]);
      await wait(()=>button("重新读取子 Agent 记录"));
      await refresh("complete");
      await wait(()=>!document.querySelector(".coding-agent-read-error"));
      await refresh("execution-error");
      await wait(()=>document.querySelector(".coding-agent-execution-error"));
      check(document.body.innerText.includes("安全的执行失败提示。"),"execution failure shows its own message");
      check(!document.querySelector(".coding-agent-read-error"),"execution failure is not a read warning");
      for(const mode of ["localized-error","localized-model","localized-read-error"]){
        await refresh(mode);
        const detail=document.querySelector('.coding-agents-detail'),count=requests.length,texts=[];
        const selector=mode==="localized-read-error"?'.coding-agent-read-error':'.coding-agent-execution-error';
        for(const width of [320,560])for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
          detail.style.width=width+'px';
          await language.systemChanged([locale]);
          await wait(()=>document.querySelector('.coding-agent-meta').textContent.includes(language.i18n.t('agentResearchRole',{ns:'tools'})));
          const text=document.querySelector(selector).textContent;
          if(text.includes('legacy')||text.includes('private'))throw new Error('raw descriptor text leaked');
          if(mode==='localized-error'&&!text.includes('429'))throw new Error('status lost');
          if(mode==='localized-model'&&!text.includes('model-'+'x'.repeat(70)))throw new Error('model lost');
          const body=detail.querySelector('.coding-agents-body');
          if(body.scrollWidth>body.clientWidth+1)throw new Error('child feedback overflows '+mode+' '+locale+' '+width);
          texts.push(text);
        }
        check(texts.length===12&&new Set(texts).size===6,'known child feedback translates in six languages: '+mode);
        check(document.querySelector('.coding-agents-detail')===detail&&requests.length===count,'known child feedback retains selection and polling: '+mode);
        check(document.querySelector('[role="dialog"]').textContent.includes(language.i18n.t('agentDefaultLabel',{ns:'tools'})),'host default label translates: '+mode);
        await language.systemChanged(['zh-CN']);
        await wait(()=>button('重新读取子 Agent 记录'));
      }
      await refresh("complete");
      await wait(()=>document.querySelector(".workflow-rich-text"));
      await refresh("list-error");
      await wait(()=>document.body.innerText.includes("列表读取失败"));
      check(document.querySelector(".workflow-rich-text").textContent.includes("已读取的结果"),"list failure retains cached content");
      check(requests.every(request=>request.method==="GET"),"retries never resubmit execution");
      document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
      await wait(()=>!document.querySelector('[role="dialog"]'));
      check(document.activeElement===button("对话菜单"),"Escape restores focus to the More menu");
      mode="complete";
      await openCatalog();
      await wait(()=>button("重新读取子 Agent 记录") && !button("重新读取子 Agent 记录").disabled);
      await refresh("running");
      await wait(()=>document.querySelector(".coding-agent-meta").textContent.includes("执行中"));
      const beforeClose=requests.length;
      button("关闭子 Agent").click();
      await wait(()=>requests.length>beforeClose);
      const afterClose=requests.length;
      mode="complete";
      await wait(()=>requests.length>afterClose);
      check(!document.querySelector('[role="dialog"]'),"running children remain observed while the parent and catalog are idle");
      button("打开搜索").click();
      await wait(()=>document.querySelector('.conversation-search-field input'));
      const input=document.querySelector('.conversation-search-field input');
      check(document.activeElement===input,"search receives focus when opened");
      check(getComputedStyle(input.closest('.conversation-search-field')).borderRadius!=="0px" && getComputedStyle(input.closest('.conversation-search-field')).backgroundColor==="rgb(35, 35, 36)","search field uses the rounded theme surface");
      check(getComputedStyle(input).backgroundColor==="rgba(0, 0, 0, 0)" && getComputedStyle(input).color==="rgb(234, 235, 238)" && getComputedStyle(input).boxShadow==="none" && getComputedStyle(input).backgroundImage==="none","composite search delegates its theme and focus to the rounded shell");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"插件 DSH");
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(()=>button("清空搜索"));
      input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await wait(()=>document.querySelector('.conversation-search-hit'));
      check(requests.some(request=>request.url.includes('q='+encodeURIComponent("插件 DSH"))),"Enter submits an encoded workspace query");
      document.querySelector('.conversation-search-hit').click();
      check(opened==="found","search results open the matched conversation");
      button("清空搜索").click();
      await wait(()=>!document.querySelector('.conversation-search-hit'));
      check(input.value==="" && document.activeElement===input,"clear removes results and restores input focus");
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await wait(()=>!document.querySelector('.conversation-search'));
      check(!document.querySelector('.conversation-search'),"Escape closes the search area");
      await openCatalog();
      await wait(()=>button("重新读取子 Agent 记录") && !button("重新读取子 Agent 记录").disabled);
      mode="hang";
      button("重新读取子 Agent 记录").click();
      await wait(()=>pending);
      root.unmount();
      await wait(()=>aborts===1);
      check(aborts===1,"unmount cancels the pending record read");
      document.getElementById("result").textContent=JSON.stringify({checks});
    })().catch(error=>document.getElementById("result").textContent=JSON.stringify({error:String(error)}));
  `;
    await writeFile(join(root, "fixture.tsx"), fixture);
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><div id="root"></div><pre id="result"></pre><script type="module" src="/fixture.tsx"></script>',
    );
    const server = await createServer({
      configFile: false,
      root,
      cacheDir: join(root, "cache"),
      logLevel: "error",
      resolve: {
        alias: {
          react: dirname(
            fileURLToPath(import.meta.resolve("react/package.json")),
          ),
          "react-dom": dirname(
            fileURLToPath(import.meta.resolve("react-dom/package.json")),
          ),
        },
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [root, fileURLToPath(new URL("../..", import.meta.url))] },
      },
    });
    t.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        `--user-data-dir=${join(root, "browser")}`,
        "--dump-dom",
        "--virtual-time-budget=10000",
        `http://127.0.0.1:${address.port}`,
      ],
      { timeout: 35_000, maxBuffer: 1_000_000 },
    );
    const result = stdout.match(/<pre id="result">(.*?)<\/pre>/su)?.[1];
    assert.ok(result, stdout.slice(-2000));
    const parsed = JSON.parse(result) as { checks?: string[]; error?: string };
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.checks?.length, 32);
  },
);
