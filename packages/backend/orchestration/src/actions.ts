import type {} from "@deepseek-ai/dsh-tools";
import type { GptImageClient } from "./gpt-image.ts";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

import { ACTION_FAILURE_CODE, type ActionBinding } from "./action-api.ts";
import type { LoadedAction } from "./action-registry.ts";
import { FlowError, jsonValue } from "./schema.ts";
import type { LocalAIClient } from "./local-ai/api.ts";
import type { AuraCapabilityClient } from "./action-api.ts";
import type { WorkflowArtifactIndex } from "./artifacts/workflow-index.ts";
import { artifactCallBinding } from "./artifacts/bindings.ts";

const internalPrefix = "aura_direct_";

/** @internal Narrows the host capability port to one Action's manifest grants. */
export function actionCapabilities(
  action: Pick<LoadedAction, "id" | "capabilities">,
  host: AuraCapabilityClient | undefined,
  binding?: string | Pick<ActionBinding, "runId" | "stepId" | "idempotencyKey">,
): AuraCapabilityClient | undefined {
  if (!host) return undefined;
  const call =
    typeof binding === "string" ? { runId: binding } : (binding ?? {});
  const context = Object.freeze({
    ...(call.runId ? { runId: call.runId } : {}),
    ...(call.stepId ? { stepId: call.stepId } : {}),
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
  });
  const allowed = new Set(action.capabilities);
  return Object.freeze({
    invoke(
      capability: string,
      operation: string,
      input: Parameters<AuraCapabilityClient["invoke"]>[2],
      signal: AbortSignal,
    ) {
      if (!allowed.has(capability))
        throw new Error(
          `Aura host capability was not declared by ${action.id}: ${capability}`,
        );
      return host.invoke(capability, operation, input, signal, context);
    },
  });
}

/** Thin adapter to the single DSH ToolRuntime, including policy, validation and timeout. */
export class ActionRuntime {
  private ctx: Context;
  private directMasks = new Map<string, Array<() => void>>();
  private localAI?: LocalAIClient;
  private aura?: AuraCapabilityClient;
  private artifacts?: WorkflowArtifactIndex;
  private gptImage?: GptImageClient;

  constructor(
    ctx: Context,
    localAI?: LocalAIClient,
    aura?: AuraCapabilityClient,
    artifacts?: WorkflowArtifactIndex,
    gptImage?: GptImageClient,
  ) {
    this.ctx = ctx;
    this.localAI = localAI;
    this.aura = aura;
    this.artifacts = artifacts;
    this.gptImage = gptImage;
    // Direct calls require an unscoped DSH registration. Keep these short-lived,
    // pinned definitions out of every Agent's model surface, without changing presets.
    const hideDirectTools = (agent: Agent) => {
      for (const [name, masks] of this.directMasks)
        masks.push(agent.ctx.tools.restrict({ deny: [name] }));
    };
    ctx.on("agent/created", ({ agent }) => {
      hideDirectTools(agent);
      return undefined;
    });
    ctx.tools.guard((exec) =>
      exec.agent && exec.name.startsWith(internalPrefix)
        ? "Direct Action dispatch is backend-only."
        : undefined,
    );
  }

  mount(
    agent: Agent,
    actions: readonly LoadedAction[],
    binding: ActionBinding,
  ): () => void {
    const dispose: Array<() => void> = [];
    try {
      for (const action of actions) {
        const release = action.retainServices?.();
        if (release) dispose.push(release);
        if (agent.ctx.tools.get(action.toolName, agent))
          throw new FlowError(`Action 与已有 DSH 工具重名：${action.id}`);
        dispose.push(
          agent.ctx.tools.register(
            action.tool(action.toolName, {
              ...binding,
              localAI: this.localAI,
              services: action.services,
              aura: actionCapabilities(action, this.aura, binding),
              gptImage:
                action.id === "image-generate" ? this.gptImage : undefined,
              bindCall: artifactCallBinding(
                this.artifacts,
                binding,
                this.localAI,
                actionCapabilities(action, this.aura, binding),
                action.id === "image-generate" ? this.gptImage : undefined,
              ),
            }),
          ),
        );
      }
    } catch (error) {
      for (const remove of dispose.reverse()) remove();
      throw error;
    }
    return () => {
      for (const remove of dispose.reverse()) remove();
    };
  }

  async execute(
    action: LoadedAction,
    input: unknown,
    binding: ActionBinding,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const args = jsonValue(input, "Action 入参");
    const callId = ToolCallId(randomUUID());
    const name = `${internalPrefix}${callId.replaceAll("-", "")}`;
    const release = action.retainServices?.();
    let dispose: () => void;
    try {
      dispose = this.ctx.tools.register(
        action.tool(name, {
          ...binding,
          localAI: this.localAI,
          services: action.services,
          aura: actionCapabilities(action, this.aura, binding),
          gptImage: action.id === "image-generate" ? this.gptImage : undefined,
          bindCall: artifactCallBinding(
            this.artifacts,
            binding,
            this.localAI,
            actionCapabilities(action, this.aura, binding),
            action.id === "image-generate" ? this.gptImage : undefined,
          ),
        }),
      );
    } catch (error) {
      release?.();
      throw error;
    }
    const masks: Array<() => void> = [];
    this.directMasks.set(name, masks);
    try {
      for (const agent of this.ctx.agents.list())
        masks.push(agent.ctx.tools.restrict({ deny: [name] }));
      const result = await this.ctx.tools.execute({
        callId,
        name,
        arguments: args,
        signal,
      });
      if (result.isError) {
        const code = result.error.info?.code ?? "ACTION_FAILED";
        if (
          code === ACTION_FAILURE_CODE &&
          result.error.info?.name === "ActionFailure"
        )
          throw new FlowError(result.error.message);
        throw new FlowError(`Action ${action.id} 执行失败（${code}）。`);
      }
      return jsonValue(result.value, "Action 出参");
    } finally {
      // DSH settles cooperatively before cleanup; no abandoned tool promises.
      dispose();
      this.directMasks.delete(name);
      for (const remove of masks) remove();
      release?.();
    }
  }
}
