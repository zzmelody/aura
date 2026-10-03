import { defineFlow, z } from "@aura/orchestration/flow";

/** @param {import("@aura/protocol/types").JsonValue} value */
function mediaPath(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.files) ||
    typeof value.files[0] !== "string"
  )
    throw new Error("语音合成没有返回可用的音频文件。");
  return value.files[0];
}

export default defineFlow({
  title: "语音合成",
  description: "把一段文字合成为 WAV 配音，可选择预设音色与语言。",
  input: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("要朗读的文字，最多 2000 字。"),
    speaker: z
      .enum([
        "Vivian",
        "Serena",
        "Uncle_Fu",
        "Dylan",
        "Eric",
        "Ryan",
        "Aiden",
        "Ono_Anna",
        "Sohee",
      ])
      .default("Vivian")
      .describe("预设音色。"),
    language: z
      .enum(["Auto", "Chinese", "English", "Japanese", "Korean"])
      .default("Auto")
      .describe("朗读语言；Auto 按文字自动判断。"),
  }),
  output: z.object({ audioPath: z.string() }),
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const speech = await flow.action({
        id: "speech",
        label: "合成语音",
        action: "local-tts",
        input: {
          text: input.text,
          language: input.language,
          speaker: input.speaker,
        },
      });
      return { audioPath: mediaPath(speech.output) };
    });
  },
});
