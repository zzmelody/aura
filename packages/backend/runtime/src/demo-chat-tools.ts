import type { ChatMessage } from "@aura/protocol/types";
import { isRecord } from "./validation.ts";

/** One deterministic tool call chosen by the local demo model. */
export interface DemoToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const offered = (request: Record<string, unknown>) =>
  new Set(
    (Array.isArray(request.tools) ? request.tools : []).flatMap((tool) =>
      isRecord(tool) &&
      isRecord(tool.function) &&
      typeof tool.function.name === "string"
        ? [tool.function.name]
        : [],
    ),
  );

/** The conversation already holds a tool result for this request. */
export function hasToolResult(request: unknown): boolean {
  return (
    isRecord(request) &&
    Array.isArray(request.messages) &&
    request.messages.some(
      (message) => isRecord(message) && message.role === "tool",
    )
  );
}

/** Text after a Chinese or ASCII colon, else the whole request. */
const subject = (text: string) =>
  (text.split(/[:：]/u).slice(1).join("：").trim() || text.trim()).slice(
    0,
    500,
  );

/**
 * Maps an explicit request in the latest user message to one offered chat
 * workflow tool. Real models decide this themselves; the demo model must stay
 * deterministic so offline tests exercise the same tool path.
 */
export function demoToolCall(
  request: unknown,
  history: ChatMessage[],
): DemoToolCall | undefined {
  if (!isRecord(request) || hasToolResult(request)) return undefined;
  const tools = offered(request);
  const text = [...history].reverse().find((message) => message.role === "user")?.text;
  if (!text) return undefined;
  if (tools.has("aura_tts") && /(配音|朗读|语音合成|读出来|tts)/iu.test(text))
    return { name: "aura_tts", arguments: { text: subject(text) } };
  if (
    tools.has("aura_image") &&
    /(画一张|画个|生成.{0,6}(图片|图像|插画|一张图)|出一张图)/u.test(text)
  )
    return {
      name: "aura_image",
      arguments: {
        prompt: subject(text),
        aspect: /竖/u.test(text) ? "portrait" : /横/u.test(text) ? "landscape" : "square",
      },
    };
  if (
    tools.has("aura_multi_shot_video") &&
    /(做成|生成|制作).{0,12}(视频|短片|影片)/u.test(text)
  ) {
    const story = subject(text);
    const sentences = story
      .split(/[。！？!?\n]/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 4);
    return {
      name: "aura_multi_shot_video",
      arguments: {
        name: story.slice(0, 20) || "对话生成的视频",
        shots: (sentences.length ? sentences : [story]).map((line, index) => ({
          title: `镜头 ${index + 1}`,
          narration: line.slice(0, 36),
          visualPrompt: line,
        })),
      },
    };
  }
  if (tools.has("aura_topic_research") && /(选题|调研|找.{0,4}题)/u.test(text))
    return {
      name: "aura_topic_research",
      arguments: { direction: subject(text) },
    };
  return undefined;
}

/** Plain confirmation after the backend has answered the demo tool call. */
export function demoToolReply(request: unknown): string {
  const messages =
    isRecord(request) && Array.isArray(request.messages)
      ? request.messages
      : [];
  const result = [...messages]
    .reverse()
    .find((message) => isRecord(message) && message.role === "tool");
  let value: Record<string, unknown> = {};
  try {
    const content = isRecord(result) ? result.content : undefined;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
              .join("")
          : "";
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) value = parsed;
  } catch {}
  if (value.status === "rejected")
    return `这个工作流没能启动：${String(value.error ?? "原因未知")}\n\n这是本地演示回复。`;
  return `已在这条对话里启动工作流，进度会显示在上方的运行卡片中。\n\n这是本地演示回复，工具调用由规则选择。`;
}
