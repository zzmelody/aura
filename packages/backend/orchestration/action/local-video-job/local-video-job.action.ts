import { defineAction } from "@aura/orchestration/action";
import { localAI, type VideoInput } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "本地视频作业",
  description: "提交、等待或取消受管视频生成；等待与推理生命周期分开。",
  parameters: {
    operation: {
      type: "string",
      enum: ["submit", "wait", "cancel"],
      required: true,
    },
    id: { type: "string", required: true },
    input: { type: "object", additionalProperties: true },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { data: { type: "string", required: true } },
    },
    render: (_input, output) => [{ type: "text", text: output.data }],
  },
  timeoutMs: 1800000,
  recovery: "idempotent",
  async execute(ctx, input) {
    if (!ctx.runId) throw new Error("视频作业需要所属运行。");
    const client = localAI(ctx);
    const request = {
      // Submit and wait are sibling steps; their parent scope identifies the clip.
      id: `${ctx.stepId?.split("/").slice(0, -1).join("/") ?? ""}/${input.id}`,
      owner: ctx.runId,
      ...(input.input ? { input: input.input as unknown as VideoInput } : {}),
    };
    try {
      const job = await client.videoJob(
        input.operation as "submit" | "wait" | "cancel",
        request,
        ctx.signal,
      );
      if (job.state === "completed" && job.result?.videoPath)
        await ctx.artifacts?.register(job.result.videoPath, {
          name: "生成视频.mp4",
        });
      return { data: JSON.stringify(job) };
    } catch (error) {
      if (ctx.signal.aborted)
        await client.videoJob("cancel", request, AbortSignal.timeout(30_000));
      throw error;
    }
  },
});
