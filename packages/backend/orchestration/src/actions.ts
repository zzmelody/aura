import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tools";
import type { ActionBinding } from "./action-api.ts";
import type { LoadedAction } from "./action-registry.ts";
import { FlowError, jsonValue } from "./schema.ts";

const internalPrefix = "aura_direct_";

/** Thin adapter to the single DSH ToolRuntime, including policy, validation and timeout. */
export class ActionRuntime {
  private ctx: Context;
  private directMasks = new Map<string, Array<() => void>>();

  constructor(ctx: Context) {
    this.ctx = ctx;
    // Direct calls require an unscoped DSH registration. Keep these short-lived,
    // pinned definitions out of every Agent's model surface, without changing presets.
    const hideDirectTools = (agent: Agent) => {
      for (const [name, masks] of this.directMasks)
        masks.push(agent.ctx.tools.restrict({ deny: [name] }));
    };
    ctx.on("agent/created", ({ agent }) => hideDirectTools(agent));
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
        if (agent.ctx.tools.get(action.id, agent))
          throw new FlowError(`Action 与已有 DSH 工具重名：${action.id}`);
        dispose.push(agent.ctx.tools.register(action.tool(action.id, binding)));
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
    const dispose = this.ctx.tools.register(action.tool(name, binding));
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
        throw new FlowError(`Action ${action.id} 执行失败（${code}）。`);
      }
      return jsonValue(result.value, "Action 出参");
    } finally {
      // DSH settles cooperatively before cleanup; no abandoned tool promises.
      dispose();
      this.directMasks.delete(name);
      for (const remove of masks) remove();
    }
  }
}
