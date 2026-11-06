import { CodedFlowError, type ApiErrorDetails } from "@aura/protocol/errors";
import type {} from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

import { ACTION_FAILURE_CODE, type ActionBinding } from "./action-api.ts";
import type { LoadedAction } from "./action-registry.ts";
import { FlowError, jsonValue } from "./schema.ts";
import type { AuraCapabilityClient } from "./action-api.ts";
import type { WorkflowArtifactIndex } from "./artifacts/workflow-index.ts";
import { artifactCallBinding } from "./artifacts/bindings.ts";

const internalPrefix = "aura_direct_";

/** @internal Narrows the host capability port to one Action's manifest grants. */
export function actionCapabilities(
  action: Pick<LoadedAction, "id" | "permissions">,
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
  const allowed = new Set(action.permissions);
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
  private aura?: AuraCapabilityClient;
  private artifacts?: WorkflowArtifactIndex;

  constructor(
    ctx: Context,
    aura?: AuraCapabilityClient,
    artifacts?: WorkflowArtifactIndex,
  ) {
    this.ctx = ctx;
    this.aura = aura;
    this.artifacts = artifacts;
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
          throw new CodedFlowError(
            `Action 与已有 DSH 工具重名：${action.id}`,
            400,
            { code: "action_tool_conflict", params: { id: action.id } },
          );
        dispose.push(
          agent.ctx.tools.register(
            action.tool(action.toolName, {
              ...binding,
              services: action.services,
              aura: actionCapabilities(action, this.aura, binding),
              bindCall: artifactCallBinding(this.artifacts, binding),
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
    let displayFailure: ApiErrorDetails | undefined;
    try {
      dispose = this.ctx.tools.register(
        action.tool(name, {
          ...binding,
          onFailure: (details) => {
            displayFailure = details;
          },
          services: action.services,
          aura: actionCapabilities(action, this.aura, binding),
          bindCall: artifactCallBinding(this.artifacts, binding),
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
        ) {
          if (displayFailure)
            throw new CodedFlowError(result.error.message, 400, displayFailure);
          throw new FlowError(result.error.message);
        }
        throw new CodedFlowError(
          `Action ${action.id} 执行失败（${code}）。`,
          400,
          {
            code: "action_execution_failed",
            params: { id: action.id, reason: code },
          },
        );
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
