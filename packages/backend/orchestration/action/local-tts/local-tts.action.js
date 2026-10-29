import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "本地语音合成",
  description:
    "使用本机 Qwen3-TTS，支持预设音色、声音设计和参考音频克隆。自动启动并回收服务，返回 WAV 路径；参考音频只读。",
  parameters: {
    text: {
      type: "string",
      required: true,
      description: "要朗读的文本，1–10000 字符。",
    },
    mode: {
      type: "string",
      enum: ["custom-voice", "voice-design", "voice-clone"],
      default: "custom-voice",
    },
    language: {
      type: "string",
      enum: [
        "Auto",
        "Chinese",
        "English",
        "Japanese",
        "Korean",
        "German",
        "French",
        "Russian",
        "Portuguese",
        "Spanish",
        "Italian",
      ],
      default: "Auto",
    },
    speaker: {
      type: "string",
      enum: [
        "Vivian",
        "Serena",
        "Uncle_Fu",
        "Dylan",
        "Eric",
        "Ryan",
        "Aiden",
        "Ono_Anna",
        "Sohee",
      ],
      default: "Vivian",
    },
    instruct: {
      type: "string",
      description: "预设音色的情绪、语速等指令，最多 1000 字符。",
    },
    voiceDescription: {
      type: "string",
      description: "voice-design 必填，描述想要的声音，最多 2000 字符。",
    },
    referenceAudio: {
      type: "string",
      description: "voice-clone 必填，最多 30 MiB 的本地参考音频绝对路径。",
    },
    referenceText: {
      type: "string",
      description: "参考音频对应文字；非 xVectorOnly 克隆时必填。",
    },
    xVectorOnly: { type: "boolean", default: false },
    maxNewTokens: {
      type: "integer",
      default: 2048,
      description: "16–8192；短文本可调小。",
    },
    seed: { type: "integer", description: "0–2147483647；省略则随机。" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", required: true },
        seed: { type: "integer", required: true },
        files: { type: "array", items: { type: "string" }, required: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 1800000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    return localAI(ctx).tts(input, ctx.signal);
  },
});
