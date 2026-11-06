import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "conversation languages preserve drafts, answers, expanded tools and the live connection",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check conversation languages in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "aura-conversation-language-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    const maskBundle = await readFile(
      createRequire(import.meta.url).resolve(
        "@deepseek-ai/dsh-client-ui-secret-mask/client",
      ),
      "utf8",
    );
    // Real panes and conversation store, with a synthetic HTTP and event stream boundary.
    await writeFile(
      entry,
      `
import React from ${modulePath("react")};
import * as jsxRuntime from ${modulePath("react/jsx-runtime")};
import {Context} from ${modulePath("@deepseek-ai/cordis")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {palettes} from ${modulePath("@aura/ui/theme")};
import {ConversationPane} from ${source("../src/features/coding/ConversationPane.tsx")};
import {conversations} from ${source("../src/features/coding/conversation-store.ts")};
import {installSecretMask} from ${source("../src/features/coding/secret-mask.ts")};
import {MaskedUserText} from ${source("../src/features/coding/MaskedUserText.tsx")};
import {TerminalCloseDialog} from ${source("../src/features/coding/TerminalCloseDialog.tsx")};
import {TrajectoryView} from ${source("../src/features/coding/TrajectoryView.tsx")};
import {turnsFromHistory} from ${source("../src/features/coding/turns.ts")};
import ${source("../src/styles.css")};
import ${source("../src/features/coding/coding.css")};
const endpoint="https://synthetic.example";
const requests=[], commands=[], snapshots=[];
let connections=0, closes=0, closeAttempts=0;
const epoch="00000000-0000-4000-8000-000000000001";
const credential="ghp_"+"a".repeat(36);
const startedAt=Date.now()-65000;
const question={id:"choice",question:"模型问题 / Original question",options:[{label:"原始选项 A"},{label:"Original option B"}]};
const approval={id:"grant",kind:"approval",question:"原始审批 / Original approval",options:[{label:"允许这一次"},{label:"拒绝"}]};
const snapshot=id=>["failed","admission"].includes(id)?({version:1,sessionId:id,cursor:epoch+":1",running:false,hasMore:false,
  turns:id==="failed"?[{turnId:"failed-turn",prompt:"原始失败消息 / Original failed prompt",startedAt,status:"error",error:"legacy turn error",errorDetails:{code:"conversation_source_mismatch",params:{token:"private"}},events:[]}]:[],
  execution:{id:"failed-execution",commandId:epoch,status:"error",prompt:"原始失败消息 / Original failed prompt",startedAt,endedAt:startedAt+1,error:"legacy execution error",errorDetails:{code:"conversation_source_mismatch",params:{token:"private"}}}
}):({version:1,sessionId:id,cursor:epoch+":1",running:true,hasMore:false,
  execution:{id:"execution-"+id,commandId:epoch,status:"running",prompt:"用户原文 / Original prompt",startedAt},
  turns:[{turnId:"turn-"+id,prompt:"用户原文 / Original prompt",startedAt,status:"running",events:[
    {type:"delta",text:"模型回复 / Original reply"},
    {type:"tool",phase:"start",callId:"read",name:"read",detail:"src/original.ts",at:startedAt+1},
    {type:"tool",phase:"end",callId:"read",ok:true,at:startedAt+2},
    {type:"question",questionId:"question-"+id,questions:[id==="approval"?approval:question]}
  ]}]});
globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input)),path=url.pathname;
  requests.push({path,method:options?.method??"GET"});
  const id=path.split("/")[3];
  if(path==="/chat/models") return Response.json({mode:"codex",defaultModel:"model",models:[{id:"model",name:"Original model"}]});
  if(path==="/coding/channel") return Response.json({version:1});
  if(path.endsWith("/skills")) return Response.json([]);
  if(path.endsWith("/collaboration")) return Response.json({});
  if(path.endsWith("/snapshot")||path.endsWith("/history")) return Response.json(snapshot(id));
  if(path.endsWith("/events")) {
    connections++;
    return new Response(new ReadableStream({start(controller){
      const value=snapshot(id);
      controller.enqueue(new TextEncoder().encode("event: snapshot\\nid: "+value.cursor+"\\ndata: "+JSON.stringify(value)+"\\n\\n"));
      options?.signal?.addEventListener("abort",()=>{closes++;controller.close();},{once:true});
    }}),{headers:{"Content-Type":"text/event-stream"}});
  }
  if(path.includes("/commands")) {
    const command=options?.body?JSON.parse(options.body):undefined;
    if(command)commands.push(command);
    return Response.json({sessionId:id,executionId:"execution-"+id,commandId:command?.commandId??path.split("/").at(-1),status:"rejected",error:"legacy answer error",errorDetails:{code:"question_closed",params:{token:"private"}}});
  }
  throw new Error("Unexpected synthetic request: "+path);
};
const rootNode=document.getElementById("root"),root=createRoot(rootNode);
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async(selector)=>{for(let i=0;i<100&&!document.querySelector(selector);i++)await settle();if(!document.querySelector(selector))throw new Error("Missing "+selector);};
const click=selector=>flushSync(()=>document.querySelector(selector).click());
const edit=(input,value)=>flushSync(()=>{Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
const noop=()=>{};
for(const [key,value] of Object.entries(palettes.dark)) document.documentElement.style.setProperty("--"+key,value);
async function inspect(){
  const context=new Context();
  const mask=context.plugin(ctx=>installSecretMask(ctx,window.maskFactory(name=>name==="react"?React:jsxRuntime)));
  await mask.await();
  await language.systemChanged(["zh-CN"]);
  const trajectoryTurns=turnsFromHistory("trajectory",[{...snapshot('approval').turns[0],status:'complete',endedAt:startedAt+1000}]);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,
    React.createElement(TrajectoryView,{turns:trajectoryTurns}),
    React.createElement("div",{id:"masked"},React.createElement(MaskedUserText,{text:credential})),
    React.createElement(TerminalCloseDialog,{terminal:{title:"Original terminal"},onCancel:noop,onConfirm:async()=>{closeAttempts++;throw null;}}),
    ...["approval","question","failed","admission"].map(id=>
    React.createElement("section",{key:id,id,className:"pane-host"},React.createElement(ConversationPane,{
      endpoint,provider:"codex",projectId:"project",sessionId:id,label:"Original composer",placeholder:"Original placeholder",
      initialDraft:"未发送草稿 / Unsaved draft",onProvider:noop,modelConfig:{},onModelConfig:noop,
    }))
  ))));
  await waitFor('#approval .coding-decision.approval');
  await waitFor('#question .coding-question-custom');
  await waitFor('#failed .coding-error');
  await waitFor('#admission .coding-error');
  const terminalDialog=document.querySelector('.session-dialog');
  terminalDialog.close();
  const plot=document.querySelector('.trajectory-plot');
  const rowsBefore=document.querySelectorAll('.trajectory-table tbody tr').length;
  // Synthetic pointer events have no native capture session; the range logic is real.
  plot.setPointerCapture=()=>{};
  const box=plot.getBoundingClientRect();
  for(const [type,ratio] of [['pointerdown',.25],['pointermove',.75],['pointerup',.75]]){
    flushSync(()=>plot.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0,buttons:1,pointerType:'mouse',clientX:box.left+box.width*ratio})));
    // Continuous pointer updates need a frame before the next discrete event.
    await new Promise(resolve=>setTimeout(resolve,50));await settle();
  }
  if(rowsBefore!==1||document.querySelectorAll('.trajectory-table tbody tr').length!==0)throw new Error('Range did not filter tool rows');
  terminalDialog.showModal();
  flushSync(()=>document.querySelector('.session-dialog form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await waitFor('.session-dialog [role="alert"]');
  const maskButton=document.querySelector('#masked button');
  if(document.getElementById('masked').textContent.includes(credential))throw new Error("Secret was not initially masked");
  click('#masked button');
  const draft=document.querySelector('#approval textarea');
  edit(draft,"编辑后的草稿 / Edited draft");
  const custom=document.querySelector('#question .coding-question-custom');
  edit(custom,"自定义回答 / Custom answer");
  click('#question .coding-question-option input');
  click('#approval .coding-tool-group-toggle');
  click('#approval .coding-decision .allow');
  await waitFor('#approval .coding-decision-error');
  // Allow receipt refresh and invalidation to settle before measuring language-only effects.
  await new Promise(resolve=>setTimeout(resolve,400));await settle();
  const before=JSON.stringify(requests);
  for(const width of [1120,360,320]) {
    rootNode.style.width=width+"px";
    for(const locale of ["zh-CN","en","ja","ko","ru","fr"]) {
      await language.systemChanged([locale]);await settle();
      const approval=document.getElementById('approval'),question=document.getElementById('question');
      snapshots.push({locale,width,draft:draft.value,custom:custom.value,
        sameDraft:draft===approval.querySelector('textarea'),sameCustom:custom===question.querySelector('.coding-question-custom'),
        checked:question.querySelector('.coding-question-option input').checked,
        expanded:approval.querySelector('.coding-tool-group-toggle').getAttribute('aria-expanded'),
        allow:approval.querySelector('.allow').textContent,
        error:approval.querySelector('.coding-decision-error').textContent,
        executionError:document.querySelector('#failed .coding-error').textContent,
        admissionError:document.querySelector('#admission .coding-error').textContent,
        tool:approval.querySelector('.coding-tool-group-title').textContent,
        state:approval.querySelector('.coding-process-state').textContent,
        answerLabel:custom.getAttribute('aria-label'),
        maskLabel:maskButton.getAttribute('aria-label'),sameMask:maskButton===document.querySelector('#masked button'),
        revealed:maskButton.getAttribute('aria-pressed'),
        closeError:document.querySelector('.session-dialog [role="alert"]').textContent,
        closeTitle:document.getElementById('terminal-close-title').textContent,closeAttempts,
        rangeLabel:document.querySelector('.trajectory-toolbar button').textContent,
        samePlot:document.querySelector('.trajectory-plot')===plot,
        filteredRows:document.querySelectorAll('.trajectory-table tbody tr').length,
        timelineOverflow:document.querySelector('.trajectory').scrollWidth>document.querySelector('.trajectory').clientWidth+1,
        prompt:approval.querySelector('.coding-prompt').textContent,
        hasReply:approval.textContent.includes('模型回复 / Original reply'),
        hasQuestion:question.textContent.includes('模型问题 / Original question'),
        hasOptions:question.textContent.includes('原始选项 A')&&question.textContent.includes('Original option B'),
        unchangedRequests:before===JSON.stringify(requests),connections,closes,
        overflow:[...document.querySelectorAll('.coding-pane,.coding-decision,.coding-question,.chat-composer')].filter(el=>el.clientWidth&&el.scrollWidth>el.clientWidth+1).map(el=>el.className)
      });
    }
  }
  click('#question .coding-question-actions button');
  await waitFor('#question .coding-question [role="alert"]');
  root.unmount();conversations.close();await mask.dispose();await settle();
  document.getElementById('result').textContent=JSON.stringify({snapshots,commands,requests,connections,closes});
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
          name: "ConversationFixture",
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
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}body{margin:0}#root{width:1120px;container:workspace / inline-size}.pane-host{display:flex;height:800px;min-width:0}</style></head><body><div id="root"></div><pre id="result"></pre><script>window.__ModuleLoader__={load:bundle=>window.maskFactory=bundle.factory};${maskBundle.replaceAll("</script", "<\\/script")}</script><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
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
    assert.ok(json, "The browser returned conversation language results");
    const result = JSON.parse(json) as {
      error?: string;
      connections: number;
      closes: number;
      commands: Array<{
        type: string;
        questionId: string;
        answers: Array<{ id: string; selected: string[]; custom?: string }>;
      }>;
      snapshots: Array<{
        locale: string;
        width: number;
        draft: string;
        custom: string;
        sameDraft: boolean;
        sameCustom: boolean;
        checked: boolean;
        expanded: string;
        allow: string;
        error: string;
        executionError: string;
        admissionError: string;
        tool: string;
        state: string;
        answerLabel: string;
        maskLabel: string;
        sameMask: boolean;
        revealed: string;
        closeError: string;
        closeTitle: string;
        closeAttempts: number;
        rangeLabel: string;
        samePlot: boolean;
        filteredRows: number;
        timelineOverflow: boolean;
        prompt: string;
        hasReply: boolean;
        hasQuestion: boolean;
        hasOptions: boolean;
        unchangedRequests: boolean;
        connections: number;
        closes: number;
        overflow: string[];
      }>;
    };
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.snapshots.length, 18);
    for (const item of result.snapshots) {
      const label = `${item.locale} at ${item.width}px`;
      assert.equal(item.draft, "编辑后的草稿 / Edited draft", label);
      assert.equal(item.custom, "自定义回答 / Custom answer", label);
      for (const key of [
        "sameDraft",
        "sameCustom",
        "sameMask",
        "samePlot",
        "checked",
        "hasReply",
        "hasQuestion",
        "hasOptions",
        "unchangedRequests",
      ] as const)
        assert.equal(item[key], true, `${key}: ${label}`);
      assert.equal(item.expanded, "true", label);
      assert.equal(item.revealed, "true", label);
      assert.equal(item.closeAttempts, 1, label);
      assert.equal(item.filteredRows, 0, label);
      assert.equal(item.timelineOverflow, false, label);
      assert.ok(item.closeTitle.includes("Original terminal"), label);
      assert.equal(item.prompt, "用户原文 / Original prompt", label);
      assert.equal(item.connections, 4, label);
      assert.equal(item.closes, 0, label);
      assert.deepEqual(item.overflow, [], label);
      assert.doesNotMatch(
        item.error + item.executionError,
        /legacy|private/u,
        label,
      );
      assert.equal(item.admissionError, item.executionError, label);
    }
    for (const field of [
      "allow",
      "error",
      "executionError",
      "tool",
      "state",
      "answerLabel",
      "maskLabel",
      "closeError",
      "closeTitle",
      "rangeLabel",
    ] as const)
      assert.equal(
        new Set(result.snapshots.map((item) => item[field])).size,
        6,
        `${field} changes in all six languages`,
      );
    assert.deepEqual(
      result.commands.map((command) => ({
        type: command.type,
        questionId: command.questionId,
        answers: command.answers,
      })),
      [
        {
          type: "question.answer",
          questionId: "question-approval",
          answers: [{ id: "grant", selected: ["允许这一次"] }],
        },
        {
          type: "question.answer",
          questionId: "question-question",
          answers: [
            {
              id: "choice",
              selected: ["原始选项 A"],
              custom: "自定义回答 / Custom answer",
            },
          ],
        },
      ],
    );
    assert.equal(result.connections, 4);
    assert.equal(result.closes, 4);
  },
);
