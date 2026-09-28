import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tools";
import { ACTION_FAILURE_CODE, type ActionBinding } from "./action-api.ts";
import type { LoadedAction } from "./action-registry.ts";
import { FlowError, jsonValue } from "./schema.ts";
import type { LocalAIClient } from "./local-ai/api.ts";
import type { AuraCapabilityClient } from "./action-api.ts";
import type { WorkflowArtifactIndex } from "./workflow-artifacts.ts";
import { artifactCallBinding } from "./artifact-bindings.ts";

const internalPrefix = "aura_direct_";

/** @internal Narrows the host capability port to one Action's manifest grants. */
export function actionCapabilities(
  action: Pick<LoadedAction, "id" | "capabilities">,
  host: AuraCapabilityClient | undefined,
): AuraCapabilityClient | undefined {
  if (!host) return undefined;
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
      return host.invoke(capability, operation, input, signal);
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
  private videoProduction?: import("./video-library.ts").VideoLibrary;
  private contentProduction?: import("./content-library.ts").ContentLibrary;
  private topicLibrary?: import("./topic-library.ts").TopicLibrary;
  private contentAnalytics?: import("./content-analytics.ts").ContentAnalyticsLibrary;

  constructor(
    ctx: Context,
    localAI?: LocalAIClient,
    aura?: AuraCapabilityClient,
    artifacts?: WorkflowArtifactIndex,
    videoProduction?: import("./video-library.ts").VideoLibrary,
    contentProduction?: import("./content-library.ts").ContentLibrary,
    topicLibrary?: import("./topic-library.ts").TopicLibrary,
    contentAnalytics?: import("./content-analytics.ts").ContentAnalyticsLibrary,
  ) {
    this.ctx = ctx;
    this.localAI = localAI;
    this.aura = aura;
    this.artifacts = artifacts;
    this.videoProduction = videoProduction;
    this.contentProduction = contentProduction;
    this.topicLibrary = topicLibrary;
    this.contentAnalytics = contentAnalytics;
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
        if (agent.ctx.tools.get(action.toolName, agent))
          throw new FlowError(`Action 与已有 DSH 工具重名：${action.id}`);
        dispose.push(
          agent.ctx.tools.register(
            action.tool(action.toolName, {
              ...binding,
              localAI: this.localAI,
              contentProduction: action.id === "content-project" ? this.contentProduction : undefined,
              topicLibrary: ["topic-library", "topic-collect"].includes(action.id) ? this.topicLibrary : undefined,
              contentAnalytics: action.id === "content-review" ? this.contentAnalytics : undefined,
              videoProduction:
                action.id === "video-project" || action.id === "video-compose"
                  ? this.videoProduction
                  : undefined,
              aura: actionCapabilities(action, this.aura),
              bindCall: artifactCallBinding(
                this.artifacts,
                binding,
                this.localAI,
                actionCapabilities(action, this.aura),
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
    const dispose = this.ctx.tools.register(
      action.tool(name, {
        ...binding,
        localAI: this.localAI,
        contentProduction: action.id === "content-project" ? this.contentProduction : undefined,
        topicLibrary: ["topic-library", "topic-collect"].includes(action.id) ? this.topicLibrary : undefined,
        contentAnalytics: action.id === "content-review" ? this.contentAnalytics : undefined,
        videoProduction:
          action.id === "video-project" || action.id === "video-compose"
            ? this.videoProduction
            : undefined,
        aura: actionCapabilities(action, this.aura),
        bindCall: artifactCallBinding(
          this.artifacts,
          binding,
          this.localAI,
          actionCapabilities(action, this.aura),
        ),
      }),
    );
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
    }
  }
}
