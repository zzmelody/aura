import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { OrchestrationHost, readCreatorLeases } from "../src/index.ts";

test("live durable cancel invokes host cleanup after the creator Flow stops", { timeout: 90_000,
  skip: Number(process.versions.node.split(".")[0]) < 24 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-live-creator-cancel-"));
  let active = "", ends = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let data;
    if (body.tool === "veya.playtest.begin") { active = "test_creator"; data = { operation_id: "op_test", status: "queued" }; }
    else if (body.tool === "veya.operation.status") data = { status: "succeeded", result: { ok: true, data: { playtest_id: active } } };
    else if (body.tool === "veya.world.status") data = { playtest_id: active };
    else if (body.tool === "veya.playtest.end") { assert.equal(body.arguments.playtest_id, "test_creator"); ++ends; active = ""; data = { playtest_id: "" }; }
    else throw new Error("unexpected test request");
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const pluginRoot = join(root, "plugin"), flows = join(pluginRoot, "flows"), actions = join(pluginRoot, "actions");
  const flowRoot = join(root, "builtins"), actionRoot = join(root, "builtin-actions");
  const descriptor = join(root, "worker.json"), session = "a".repeat(32), requestId = randomUUID();
  await Promise.all([mkdir(join(flows, "veya-wish"), { recursive: true }), mkdir(join(actions, "begin"), { recursive: true }),
    mkdir(join(pluginRoot, "node_modules", "@aura"), { recursive: true }), mkdir(flowRoot), mkdir(actionRoot),
    mkdir(join(root, ".aura", "veya-creator"), { recursive: true })]);
  await symlink(fileURLToPath(new URL("../../plugin-sdk", import.meta.url)), join(pluginRoot, "node_modules", "@aura", "plugin-sdk"), "junction");
  await writeFile(descriptor, JSON.stringify({ role: "creator-worker", creation_session_id: session, protocol: "veya-world-http/1",
    tools_protocol: "veya-agent-tools/1", base_url: `http://127.0.0.1:${address.port}`, token: "b".repeat(64) }));
  await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
    bindings: { [requestId]: { sessionPath: descriptor, creationSessionId: session, homeWorldId: "home" } } }));
  await writeFile(join(actions, "begin", "begin.action.js"), `
import {defineAction,auraCapability} from '@aura/plugin-sdk/action';
export default defineAction({title:'Begin test',description:'Only begin; host owns cancellation',parameters:{},recovery:'idempotent',timeoutMs:10000,
 output:{schema:{type:'object',additionalProperties:true},render:()=>[]},async execute(ctx){
 const worker=auraCapability(ctx,'aura.veya.world-agent');
 const begun=await worker.invoke('veya.playtest.begin',{request_id:ctx.idempotencyKey??ctx.callId});
 return worker.invoke('veya.operation.status',{operation_id:begun.operation_id});}});
`);
  await writeFile(join(flows, "veya-wish", "veya-wish.flow.js"), `
import {defineFlow,z} from '@aura/plugin-sdk/flow';
export default defineFlow({title:'Cancellation test',service:true,input:z.object({}),output:z.object({ok:z.boolean()}),
 async run(ctx){await ctx.sequence({id:'main'},async flow=>{await flow.action({id:'begin',action:'veya/begin',input:{}});
 await flow.checkpoint({id:'wait',prompt:'Wait',schema:z.object({ok:z.boolean()})});});return {ok:true};}});
`);
  const plugin = { id: "veya", name: "Veya cancellation fixture", version: "1.0.0" };
  const host = new OrchestrationHost({ root, flowRoot, actionRoot, dshHome: join(root, "dsh"), modelURL: "http://127.0.0.1:1/v1",
    worldAgentSessionPath: join(root, "missing-default.json"),
    flowRoots: [{ root: flows, pluginRoot, namespace: "veya", plugin }],
    actionRoots: [{ root: actions, pluginRoot, namespace: "veya", plugin, capabilities: ["aura.veya.world-agent"] }],
    plugins: [{ ...plugin, enabled: true, available: true }] });
  try {
    const started = await host.request<FlowRun>("start", { requestId, flowId: "veya/veya-wish", mode: "demo", input: {} });
    const waiting = await host.request<FlowRun>("wait", { id: started.id });
    assert.equal(waiting.status, "waiting_input", JSON.stringify(waiting)); assert.equal(active, "test_creator");
    const commandId = randomUUID();
    const cancelled = await host.request<FlowRun>("cancel", { id: started.id, requestId: commandId });
    assert.equal(cancelled.status, "cancelled"); assert.equal(active, ""); assert.equal(ends, 1);
    await host.request("cancel", { id: started.id, requestId: commandId });
    assert.equal(ends, 1); assert.deepEqual((await readCreatorLeases(root)).leases, {});
  } finally {
    await host.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
