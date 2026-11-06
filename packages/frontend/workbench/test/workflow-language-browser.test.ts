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
  "workflow languages preserve inputs, preview selection and uncertain command identity",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check workflow languages in Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-workflow-language-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modulePath = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    // Real forms, controls and preview hook with synthetic HTTP; no workflow executes.
    await writeFile(
      entry,
      `
import React,{useState} from ${modulePath("react")};
import {createRoot} from ${modulePath("react-dom/client")};
import {flushSync} from ${modulePath("react-dom")};
import {LanguageProvider} from ${modulePath("@aura/i18n")};
import {language} from ${modulePath("@aura/i18n/runtime")};
import {palettes,fontStacks} from ${modulePath("@aura/ui/theme")};
import {WorkflowRunForm} from ${source("../src/screens/WorkflowRunForm.tsx")};
import {WorkflowControls} from ${source("../src/screens/WorkflowControls.tsx")};
import {Workflows} from ${source("../src/screens/Workflows.tsx")};
import {WorkflowRunResult} from ${source("../src/screens/WorkflowRun.tsx")};
import {WorkflowChat} from ${source("../src/screens/WorkflowChat.tsx")};
import {ImagePreview} from ${source("../src/screens/WorkflowArtifacts.tsx")};
import {WorkflowModelPreview} from ${source("../src/screens/WorkflowModelPreview.tsx")};
import {workflowRuns} from ${source("../src/workflow-run-store.ts")};
import {tripoStageMessages} from ${source("../../../../plugins/tripo/shared/error-messages.ts")};
import ${source("../src/styles.css")};
const endpoint="https://synthetic.example",commands=[],snapshots=[],submissions=[];
let previews=0,changes=0,received=0,reads=0,histories=0,artifacts=0,chatChanges=0;
const noop=()=>{};
const run={id:"run",status:"waiting_input",recoveryEvents:[{at:1735689600000,reason:"legacy run recovery",reasonDetails:{code:"recovery_restarted"}}],steps:[{id:"checkpoint",stepKey:"checkpoint",kind:"checkpoint",label:"原始检查点 / Original checkpoint",prompt:"原始问题 / Original question",status:"waiting_input",outputSchema:{type:"string"}}]};
const flow={id:"sample/flow",title:"原始工作流 / Original workflow",description:"原始说明 / Original description",available:true};
const catalogState={catalog:{flows:[flow]},refreshing:false,refresh:noop};
const analysis={entries:[]};
const schema={type:"object",required:["prompt"],properties:{
  prompt:{type:"string"},imageQuality:{type:"string",enum:["low","high"]},
  referenceImagePath:{type:"string"},custom:{type:"string",title:"原始字段 / Original field",description:"原始提示 / Original hint"},
  requiredActions:{type:"array",items:{type:"string",enum:["idle","walk"]}},
  firstFrameAssetId:{type:"string"}
}};
const completed={id:"completed",requestId:"original-request",flow:{id:flow.id,title:flow.title,description:flow.description,sourceHash:"original-hash"},
  createdAt:1735689600000,finishedAt:1735689665000,status:"completed",mode:"demo",input:{task:"原始输入 / Original input"},output:{report:"原始输出 / Original output\\n\\n|Original column|\\n|---|\\n|Original cell|",count:12345.678901,success:true},
  steps:[{id:"agent",stepKey:"agent",kind:"agent",label:"原始步骤 / Original step",status:"completed",attempts:[{number:1,status:"failed",error:"legacy attempt failure",errorDetails:{failure:{code:"model_http_failed",params:{status:429,token:"private"}},uncertainty:"agent_result_unknown"}},{number:2,status:"completed"}],
    recoveryEvents:[{at:1735689600000,reason:"legacy step recovery",reasonDetails:{code:"recovery_action_unknown"}}],config:{provider:"original-provider",model:"original-model",reasoningEffort:"high",timeoutMs:120000}}]};
const originalRun=JSON.stringify(completed);
const invalidRun={...completed,id:"invalid-run",status:"failed",output:undefined,steps:[],error:"legacy validation failure",errorDetails:{failure:{code:"validation_failed",params:{target:"flow_input",issues:[{path:"task",reason:"invalid_type",expected:"string"},{path:"count",reason:"too_small",limit:2}],remaining:0}}}};
const pluginRun={...invalidRun,id:"plugin-run",error:"legacy plugin failure",errorDetails:{failure:{code:"plugin_failure",params:{translations:tripoStageMessages("generate-left","timeout",{seconds:90})}}}};
const files=["原始字幕 A.srt","Original captions B.srt"].map((name,index)=>({id:"file-"+index,artifactId:"content-"+index,runId:"completed",stepKey:"agent",attempt:2,callId:"original-call",name,kind:"subtitle",format:"srt",mimeType:"text/plain",bytes:1572864,status:"ready"}));
globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/flows/sample%2Fflow/source"){previews++;return new Response("",{status:503});}
  if(path==="/flows/runs/completed"){reads++;throw null;}
  if(path==="/flows/runs/completed/artifacts"){artifacts++;return Response.json({artifacts:files,pending:false});}
  if(path==="/flows/runs/completed/steps/agent/history"){
    histories++;
    if(new URL(String(input)).searchParams.get("attempt")==="1")throw null;
    return Response.json({entries:[{seq:1,kind:"assistant",text:"原始历史 / Original history"}],hasMore:false});
  }
  if(path==="/flows/runs/run/steps/checkpoint/answer"){
    commands.push({path,...JSON.parse(options.body)});
    if(commands.length===1)throw null;
    return Response.json({...run,status:"completed"});
  }
  throw new Error("Unexpected synthetic request: "+path);
};
function Forms(){
  const [fields,setFields]=useState(JSON.stringify({prompt:"",imageQuality:"low",requiredActions:["idle"]}));
  const [invalid,setInvalid]=useState("{}");
  return React.createElement(React.Fragment,null,
    React.createElement(WorkflowRunForm,{id:"fields",title:flow.title,subtitle:flow.description,schema,text:fields,
      onTextChange:value=>{changes++;setFields(value);},endpoint:"",initialMode:"demo",locked:false,submitting:false,
      onSubmit:(input,mode)=>submissions.push({input,mode}),onClose:noop}),
    React.createElement(WorkflowRunForm,{id:"invalid",title:"Original JSON",subtitle:"Original JSON description",text:invalid,
      onTextChange:setInvalid,endpoint,initialMode:"demo",locked:false,submitting:false,onSubmit:()=>{throw new Error("Invalid JSON submitted");},onClose:noop}));
}
function Chat(){
  const [draft,setDraft]=useState(JSON.stringify({prompt:""}));
  const workspace={active:{id:"chat",title:"原始会话 / Original conversation",messages:[],workflow:{id:flow.id,title:flow.title,endpoint,inputSchema:{type:"object",properties:{prompt:{type:"string"}}}}},draft,
    setDraft:value=>{chatChanges++;setDraft(value);},state:{provider:"demo"},busy:false,workflows:{submitting:[],runs:{},errors:{},start:()=>{throw new Error("Unexpected workflow start");},cancel:noop,receive:noop}};
  return React.createElement("div",{id:"chat",style:{height:700,display:"flex",minWidth:0}},React.createElement(WorkflowChat,{workspace,onContinue:noop}));
}
const rootNode=document.getElementById("root"),root=createRoot(rootNode);
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));flushSync(()=>{});};
const waitFor=async(selector)=>{for(let i=0;i<100&&!document.querySelector(selector);i++)await settle();if(!document.querySelector(selector))throw new Error("Missing "+selector);};
const click=selector=>flushSync(()=>document.querySelector(selector).click());
const submit=selector=>flushSync(()=>document.querySelector(selector).dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
const edit=(input,value)=>flushSync(()=>{
  const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement?"change":"input",{bubbles:true}));
});
for(const [key,value] of Object.entries(palettes.dark))document.documentElement.style.setProperty("--"+key,value);
document.documentElement.style.setProperty("--font-text",fontStacks.system);
document.documentElement.style.setProperty("--font-mono",fontStacks.mono);
async function inspect(){
  await language.systemChanged(["zh-CN"]);
  workflowRuns.publish(endpoint,completed);
  workflowRuns.publish(endpoint,invalidRun);
  workflowRuns.publish(endpoint,pluginRun);
  flushSync(()=>root.render(React.createElement(LanguageProvider,null,
    React.createElement(Workflows,{browseRevision:0,endpoint,catalogState,draft:{},analysis,editorRevision:0,onRun:noop,onDetailChange:noop}),
    React.createElement(Forms),React.createElement(WorkflowControls,{endpoint,run,receive:()=>{received++;}}),
    React.createElement("section",{id:"run-result"},React.createElement(WorkflowRunResult,{endpoint,message:{id:"completed:output",role:"assistant",text:"已完成",status:"complete",workflowRunId:"completed",workflowPhase:"completed"},inputSchema:{type:"object",properties:{task:{title:"原始输入标题 / Original input title"}}},receive:noop,onCancel:noop,onRepeat:noop,index:2})),
    React.createElement(Chat),
    React.createElement("section",{id:"invalid-run-result"},React.createElement(WorkflowRunResult,{endpoint,message:{id:"invalid-run:output",role:"assistant",text:"legacy validation failure",status:"complete",workflowRunId:"invalid-run",workflowPhase:"failed"},receive:noop,onCancel:noop,onRepeat:noop,index:3})),
    React.createElement("section",{id:"plugin-run-result"},React.createElement(WorkflowRunResult,{endpoint,message:{id:"plugin-run:output",role:"assistant",text:"legacy plugin failure",status:"complete",workflowRunId:"plugin-run",workflowPhase:"failed"},receive:noop,onCancel:noop,onRepeat:noop,index:4})),
    React.createElement("section",{id:"image"},React.createElement(ImagePreview,{src:"data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",name:"Original image.gif"})),
    ...["model","failed-model"].map(id=>React.createElement("section",{key:id,id},React.createElement(WorkflowModelPreview,{src:"synthetic:"+id,name:"Original "+id+".glb"}))))));
  const search=document.querySelector('.workflow-card-search input');
  edit(search,"sample/flow");click('.workflow-card-open');
  await waitFor('.workflow-card-preview [role="alert"]');
  const prompt=document.querySelector('#fields textarea');
  edit(prompt,"编辑后的描述 / Edited prompt");
  edit(document.querySelector('#fields .workflow-input-select select'),JSON.stringify("high"));
  click('#fields .workflow-option:last-child input');
  edit(document.querySelector('#fields .workflow-input-image input'),"/original/reference.png");
  edit(document.querySelector('#fields .workflow-input-text input'),"用户自定义 / Custom value");
  edit(document.querySelector('#fields .workflow-compose-actions select'),"custom");
  const file=document.querySelector('#fields input[type="file"]'),transfer=new DataTransfer();
  transfer.items.add(new File(["synthetic"],"original.png",{type:"image/png"}));file.files=transfer.files;
  flushSync(()=>file.dispatchEvent(new Event("change",{bubbles:true})));
  await waitFor('#fields .workflow-field-error');
  const json=document.querySelector('#invalid textarea');edit(json,"{unfinished");submit('#invalid');
  const answer=document.querySelector('.workflow-human-step textarea');edit(answer,JSON.stringify("原始回答 / Original answer"));
  submit('.workflow-human-step form');await waitFor('.workflow-run-controls > [role="alert"]');
  const chatDraft=document.querySelector('#chat textarea');edit(chatDraft,"工作流草稿 / Workflow draft");
  click('#run-result .workflow-stream-steps > li > button');await waitFor('#run-result .workflow-history-entry');
  if(!document.querySelector('#run-result .workflow-history-entry').textContent.includes("原始历史 / Original history"))throw new Error("History text changed");
  click('#run-result [role="radio"]');await waitFor('#run-result .workflow-step-detail > [role="alert"]');
  await workflowRuns.refresh(endpoint,"completed").catch(noop);await settle();
  click('#run-result .workflow-stream-output .workflow-json-toggle');
  const raw=document.querySelector('#run-result .workflow-stream-output .workflow-raw-output');
  click('#image .artifact-image-tools button:nth-of-type(2)');
  const image=document.querySelector('#image img');flushSync(()=>image.dispatchEvent(new Event('error')));
  await waitFor('#model model-viewer');await waitFor('#failed-model model-viewer');
  const model=document.querySelector('#model model-viewer'),failedModel=document.querySelector('#failed-model model-viewer');
  flushSync(()=>model.dispatchEvent(new Event('load')));model.cameraOrbit="42deg 60deg 2m";model.cameraTarget="1m 2m 3m";
  flushSync(()=>failedModel.dispatchEvent(new Event('error')));
  click('#run-result .workflow-stream-output .artifact-card');await waitFor('.artifact-dialog[open]');
  click('.artifact-dialog-footer button:last-of-type');
  const dialog=document.querySelector('.artifact-dialog'),closeButton=document.querySelector('.artifact-dialog-header button');closeButton.focus();
  const stableChanges=changes;
  click('.workflow-run-controls details summary');
  for(const locale of ["zh-CN","en","ja","ko","ru","fr"]){
    await language.select(locale);await settle();
    for(const width of [1120,360,320]){
      rootNode.style.width=width+"px";await settle();
      const text=selector=>document.querySelector(selector)?.textContent;
      snapshots.push({locale,width,prompt:prompt.value,answer:answer.value,json:json.value,search:search.value,
        sameNodes:prompt===document.querySelector('#fields textarea')&&answer===document.querySelector('.workflow-human-step textarea')&&json===document.querySelector('#invalid textarea')&&search===document.querySelector('.workflow-card-search input'),
        expanded:document.querySelector('.workflow-card-open').getAttribute('aria-expanded'),
        title:text('.workflow-card-copy strong'),customLabel:text('#fields .workflow-input-text label'),customValue:document.querySelector('#fields .workflow-input-text input').value,
        customHint:document.querySelector('#fields .workflow-input-text input').placeholder,path:document.querySelector('#fields .workflow-input-image input').value,
        quality:document.querySelector('#fields .workflow-input-select select').value,mode:document.querySelector('#fields .workflow-compose-actions select').value,
        checked:[...document.querySelectorAll('#fields .workflow-option input')].map(input=>input.checked),
        library:text('.workflow-page-heading h1'),promptLabel:prompt.getAttribute('aria-label'),submitLabel:text('#fields button[type="submit"]'),
        previewError:text('.workflow-card-preview [role="alert"] > span'),uploadError:text('#fields .workflow-field-error'),jsonError:text('#invalid [role="alert"]'),commandError:text('.workflow-run-controls > [role="alert"]'),
        answerLabel:document.querySelector('.workflow-human-step').getAttribute('aria-label'),question:text('.workflow-human-step > p'),
        runPhase:text('#run-result .workflow-status-badge'),runMode:text('#run-result .workflow-run-meta > span'),
        runNumber:text('#run-result .workflow-run-number'),runDuration:text('#run-result .workflow-run-duration'),
        runError:document.querySelector('#run-result .workflow-fetch-error').firstChild.textContent,historyError:text('#run-result .workflow-step-detail > [role="alert"]'),
        attemptFailure:text('#run-result .workflow-step-error'),
        validationError:text('#invalid-run-result .workflow-run-problem'),
        pluginFailure:text('#plugin-run-result .workflow-run-problem'),
        runRecovery:text('.workflow-run-controls .workflow-recovery-event'),stepRecovery:text('#run-result .workflow-step-detail .workflow-recovery-event'),recoveryOpen:document.querySelector('.workflow-run-controls details').open,
        attempt:document.querySelector('#run-result [role="radio"]').getAttribute('aria-checked'),runExpanded:document.querySelector('#run-result .workflow-stream-steps > li > button').getAttribute('aria-expanded'),
        originalContent:text('#run-result').includes("原始输入 / Original input")&&text('#run-result').includes("原始输出 / Original output")&&text('#run-result').includes("原始步骤 / Original step")&&JSON.stringify(completed)===originalRun,
        raw:raw.textContent,sameRaw:raw===document.querySelector('#run-result .workflow-stream-output .workflow-raw-output'),rawExpanded:document.querySelector('#run-result .workflow-stream-output .workflow-json-toggle').getAttribute('aria-expanded'),
        number:text('#run-result .workflow-stream-output .workflow-value-number'),boolean:text('#run-result .workflow-stream-output .workflow-value-boolean'),
        dataLabel:text('#run-result .workflow-stream-output dt'),tableLabel:document.querySelector('#run-result .workflow-rich-text .workflow-table-scroll').getAttribute('aria-label'),inputTitle:text('#run-result .workflow-user-bubble dt'),
        chatDraft:chatDraft.value,sameChatDraft:chatDraft===document.querySelector('#chat textarea'),chatLabel:document.querySelector('#chat .workflow-chat').getAttribute('aria-label'),
        samePreview:dialog===document.querySelector('.artifact-dialog')&&dialog.open&&document.activeElement===closeButton,
        previewTitle:text('.artifact-dialog-header strong'),previewLabel:dialog.getAttribute('aria-label'),previewHint:text('.artifact-preview-body p'),
        downloadHref:document.querySelector('.artifact-dialog-header a').href,downloadName:document.querySelector('.artifact-dialog-header a').download,artifactSize:text('.artifact-dialog-header small'),
        imageError:text('#image [role="alert"] p'),imageZoom:text('#image .artifact-image-tools span'),sameImage:image===document.querySelector('#image img')&&image.style.transform.includes('scale(1.25)'),
        modelError:text('#failed-model [role="alert"] p'),modelHint:text('#model .artifact-stage-tools span'),sameModels:model===document.querySelector('#model model-viewer')&&failedModel===document.querySelector('#failed-model model-viewer')&&model.cameraOrbit==="42deg 60deg 2m"&&model.cameraTarget==="1m 2m 3m",
        previewOverflow:[...document.querySelectorAll('.artifact-dialog-header,.artifact-dialog-footer,.artifact-image-tools,.artifact-stage-tools')].filter(node=>{const box=node.getBoundingClientRect(),parent=node.parentElement.getBoundingClientRect();return node.scrollWidth>node.clientWidth+1||box.left<parent.left-1||box.right>parent.right+1;}).map(node=>node.className),
        unchanged:changes===stableChanges&&commands.length===1&&previews===1&&submissions.length===0&&received===0&&histories===2&&reads===1&&artifacts===1&&chatChanges===1&&globalThis.modelLoads===2&&!globalThis.modelResets,
        overflow:[...document.querySelectorAll('.workflow-library-page,.workflow-composer,.workflow-run-controls,#run-result,#chat')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.id||node.className)
      });
    }
  }
  click('.artifact-dialog-header button');
  submit('#fields');submit('.workflow-human-step form');
  for(let i=0;i<100&&received===0;i++)await settle();
  flushSync(()=>root.unmount());workflowRuns.close();
  return {snapshots,commands,submissions,received,previews,viewport:innerWidth};
}
const publish=result=>{document.getElementById('result').textContent=JSON.stringify(result);parent.postMessage(result,'*');};
inspect().then(publish).catch(error=>publish({error:String(error),stack:error?.stack,snapshots}));
document.currentScript.remove();
`,
    );
    // The custom-element boundary is synthetic; viewer lifecycle and UI are real.
    const viewerFixture = join(directory, "model-viewer.ts");
    await writeFile(
      viewerFixture,
      `export class ModelViewerElement extends HTMLElement {
      set src(value){this.dataset.src=value;globalThis.modelLoads=(globalThis.modelLoads??0)+1;}
      jumpCameraToGoal(){globalThis.modelResets=(globalThis.modelResets??0)+1;}
    }
    customElements.define("model-viewer",ModelViewerElement);`,
    );
    await build({
      configFile: false,
      root: directory,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      resolve: { alias: { "@google/model-viewer": viewerFixture } },
      build: {
        outDir: join(directory, "dist"),
        minify: false,
        lib: {
          entry,
          formats: ["iife"],
          name: "Fixture",
          fileName: () => "fixture.js",
          cssFileName: "fixture",
        },
      },
    });
    const script = await readFile(
      join(directory, "dist", "fixture.js"),
      "utf8",
    );
    const css = await readFile(join(directory, "dist", "fixture.css"), "utf8");
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>body{margin:0}#root{container:workspace / inline-size;width:1120px;height:auto;display:block}#root>.workflow-run-controls{padding:16px}#image,#model,#failed-model{position:relative;height:360px;min-width:0}</style></head><body><div id="root" class="workbench aura-root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    for (const viewportWidth of [1400, 360, 320]) {
      // Native windows can have a minimum width; the frame's viewport is exact.
      const host = join(directory, `host-${viewportWidth}.html`);
      await writeFile(
        host,
        `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="result"></pre><script>addEventListener('message',event=>document.getElementById('result').textContent=JSON.stringify(event.data));</script><iframe src="${pathToFileURL(page).href}" style="border:0;width:${viewportWidth}px;height:1000px"></iframe></body></html>`,
      );
      const { stdout } = await promisify(execFile)(
        chrome!,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          `--user-data-dir=${join(directory, "browser-" + viewportWidth)}`,
          "--window-size=1440,1100",
          "--virtual-time-budget=8000",
          "--dump-dom",
          pathToFileURL(host).href,
        ],
        { timeout: 30_000, maxBuffer: 2_000_000 },
      );
      const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
      assert.ok(
        json,
        "The browser returned workflow language results: " +
          stdout.slice(-4000),
      );
      const result = JSON.parse(
        json
          .replaceAll("&nbsp;", "\u00a0")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ) as {
        error?: string;
        viewport: number;
        received: number;
        previews: number;
        submissions: Array<{ input: unknown; mode: string }>;
        commands: Array<{ path: string; requestId: string; output: string }>;
        snapshots: Array<{
          locale: string;
          width: number;
          prompt: string;
          answer: string;
          json: string;
          search: string;
          sameNodes: boolean;
          expanded: string;
          title: string;
          customLabel: string;
          customValue: string;
          customHint: string;
          path: string;
          quality: string;
          mode: string;
          checked: boolean[];
          library: string;
          promptLabel: string;
          submitLabel: string;
          previewError: string;
          uploadError: string;
          jsonError: string;
          commandError: string;
          answerLabel: string;
          question: string;
          runPhase: string;
          runMode: string;
          runNumber: string;
          runDuration: string;
          runError: string;
          historyError: string;
          attempt: string;
          runExpanded: string;
          originalContent: boolean;
          raw: string;
          sameRaw: boolean;
          rawExpanded: string;
          number: string;
          boolean: string;
          dataLabel: string;
          tableLabel: string;
          inputTitle: string;
          chatDraft: string;
          sameChatDraft: boolean;
          chatLabel: string;
          samePreview: boolean;
          previewTitle: string;
          previewLabel: string;
          previewHint: string;
          downloadHref: string;
          downloadName: string;
          artifactSize: string;
          imageError: string;
          imageZoom: string;
          sameImage: boolean;
          modelError: string;
          modelHint: string;
          sameModels: boolean;
          previewOverflow: string[];
          attemptFailure: string;
          validationError: string;
          pluginFailure: string;
          runRecovery: string;
          stepRecovery: string;
          recoveryOpen: boolean;
          unchanged: boolean;
          overflow: string[];
        }>;
      };
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.viewport, viewportWidth);
      assert.equal(result.snapshots.length, 18);
      assert.equal(
        new Set(result.snapshots.map((item) => item.validationError)).size,
        6,
      );
      for (const field of ["runRecovery", "stepRecovery"] as const)
        assert.equal(
          new Set(result.snapshots.map((item) => item[field])).size,
          6,
        );
      assert.equal(
        new Set(result.snapshots.map((item) => item.attemptFailure)).size,
        6,
      );
      for (const item of result.snapshots) {
        const label = `${item.locale} at ${item.width}px in a ${viewportWidth}px viewport`;
        assert.equal(item.prompt, "编辑后的描述 / Edited prompt", label);
        assert.equal(
          item.answer,
          JSON.stringify("原始回答 / Original answer"),
          label,
        );
        assert.equal(item.json, "{unfinished", label);
        assert.equal(item.search, "sample/flow", label);
        assert.equal(item.sameNodes, true, label);
        assert.match(item.validationError, /task/u, label);
        assert.match(item.pluginFailure, /90/u, label);
        assert.doesNotMatch(item.pluginFailure, /legacy|\{\{/u, label);
        assert.match(item.validationError, /count/u, label);
        assert.doesNotMatch(item.validationError, /legacy|\{\{/u, label);
        assert.equal(item.recoveryOpen, true, label);
        assert.doesNotMatch(
          item.runRecovery + item.stepRecovery,
          /legacy/u,
          label,
        );
        assert.equal(item.expanded, "true", label);
        assert.equal(item.title, "原始工作流 / Original workflow", label);
        assert.ok(
          item.customLabel.startsWith("原始字段 / Original field"),
          label,
        );
        assert.equal(item.customValue, "用户自定义 / Custom value", label);
        assert.equal(item.customHint, "原始提示 / Original hint", label);
        assert.equal(item.path, "/original/reference.png", label);
        assert.equal(item.quality, JSON.stringify("high"), label);
        assert.equal(item.mode, "custom", label);
        assert.deepEqual(item.checked, [true, true], label);
        assert.equal(item.question, "原始问题 / Original question", label);
        assert.equal(item.unchanged, true, label);
        assert.equal(item.attempt, "true", label);
        assert.equal(item.runExpanded, "true", label);
        assert.equal(item.originalContent, true, label);
        assert.ok(item.attemptFailure.includes("429"), label);
        assert.doesNotMatch(item.attemptFailure, /legacy|private|\{\{/u, label);
        assert.equal(item.sameRaw, true, label);
        assert.equal(item.rawExpanded, "true", label);
        assert.deepEqual(
          JSON.parse(item.raw),
          {
            report:
              "原始输出 / Original output\n\n|Original column|\n|---|\n|Original cell|",
            count: 12345.678901,
            success: true,
          },
          label,
        );
        assert.equal(
          item.number,
          new Intl.NumberFormat(item.locale, {
            maximumSignificantDigits: 21,
          }).format(12345.678901),
          label,
        );
        assert.equal(
          item.inputTitle,
          "原始输入标题 / Original input title",
          label,
        );
        assert.equal(item.chatDraft, "工作流草稿 / Workflow draft", label);
        assert.equal(item.sameChatDraft, true, label);
        assert.equal(item.samePreview, true, label);
        assert.equal(item.previewTitle, "Original captions B.srt", label);
        assert.equal(item.downloadName, "Original captions B.srt", label);
        assert.equal(
          item.downloadHref,
          "https://synthetic.example/flows/runs/completed/artifacts/content-1/content?download=1",
          label,
        );
        assert.equal(item.sameImage, true, label);
        assert.equal(item.sameModels, true, label);
        assert.deepEqual(item.previewOverflow, [], label);
        assert.equal(
          item.imageZoom,
          new Intl.NumberFormat(item.locale, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(1.25),
          label,
        );
        assert.equal(
          item.artifactSize,
          "SRT · " +
            new Intl.NumberFormat(item.locale, {
              style: "unit",
              unit: "megabyte",
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }).format(1.5),
          label,
        );
        assert.deepEqual(item.overflow, [], label);
      }
      for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
        const messages = JSON.parse(
          await readFile(
            new URL(`../src/locales/${locale}/workflow.json`, import.meta.url),
            "utf8",
          ),
        ) as Record<string, string>;
        const expected = {
          library: messages.workflows,
          promptLabel: messages.fieldPrompt,
          submitLabel: messages.startRun,
          previewError: messages.previewRequestFailed!.replace(
            "{{status}}",
            "503",
          ),
          uploadError: messages.serviceUnavailable,
          jsonError: messages.invalidJson,
          commandError: messages.operationFailed,
          runPhase: messages.phaseCompleted,
          runMode: messages.demo,
          runError: messages.runReadFailed,
          historyError: messages.historyFailed,
          chatLabel: messages.workflowConversation,
          boolean: messages.yes,
          dataLabel: messages.valueReport,
          tableLabel: messages.dataTable,
          previewLabel: messages.previewNamedArtifact!.replace(
            "{{name}}",
            "Original captions B.srt",
          ),
          previewHint: messages.subtitleHint,
          imageError: messages.imageLoadFailed,
          modelError: messages.modelRenderFailed,
          modelHint: messages.modelGestureHint,
          answerLabel: messages.waitingInputLabel!.replace(
            "{{label}}",
            "原始检查点 / Original checkpoint",
          ),
        };
        for (const item of result.snapshots.filter(
          (item) => item.locale === locale,
        ))
          for (const [field, value] of Object.entries(expected))
            assert.equal(
              item[field as keyof typeof expected],
              value,
              `${field}: ${locale} at ${item.width}px`,
            );
      }
      assert.equal(
        new Set(result.snapshots.map((item) => item.runDuration)).size,
        6,
      );
      assert.equal(
        new Set(result.snapshots.map((item) => item.runNumber)).size,
        6,
      );
      assert.equal(result.previews, 1);
      assert.equal(result.received, 1);
      assert.equal(result.commands.length, 2);
      assert.deepEqual(result.commands[0], result.commands[1]);
      assert.equal(
        result.commands[0]?.path,
        "/flows/runs/run/steps/checkpoint/answer",
      );
      assert.ok(result.commands[0]?.requestId);
      assert.equal(result.commands[0]?.output, "原始回答 / Original answer");
      assert.deepEqual(result.submissions, [
        {
          mode: "custom",
          input: {
            prompt: "编辑后的描述 / Edited prompt",
            imageQuality: "high",
            requiredActions: ["idle", "walk"],
            referenceImagePath: "/original/reference.png",
            custom: "用户自定义 / Custom value",
          },
        },
      ]);
    }
  },
);
