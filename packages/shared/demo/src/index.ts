import type { ChatMessage } from "@aura/protocol/types";

/** Deterministic responses for offline development; never calls a model. */
export function demoReply(messages: readonly ChatMessage[]): string {
  const latest =
    messages
      .filter((m) => m.role === "user")
      .at(-1)
      ?.text.trim() ?? "";
  const previous = messages
    .filter((m) => m.role === "user")
    .at(-2)
    ?.text.trim();
  if (/^(继续|再详细|展开|然后|接着)/.test(latest) && previous) {
    return `我们接着聊「${previous.slice(0, 70)}」。\n\n可以先把它拆成三个小步骤：\n\n01  写下你希望得到的具体结果。\n02  找出今天就能完成的最小行动。\n03  完成后回看，再决定下一步。\n\n你也可以把想法补充给我，我们一起把轮廓理清楚。\n\n这是本地演示回复，用于体验多轮对话。`;
  }
  if (/计划|安排|今天|日程/.test(latest)) {
    return "给今天留一点秩序，也留一点空白。\n\n01  选一件最值得完成的事\n把它写成一个可以完成的动作，而不是模糊的目标。\n\n02  留出一段专注时间\n用 25 分钟开始，关掉暂时不需要的通知。\n\n03  用五分钟收尾\n记下进展，以及明天最想接着做的事。\n\n你今天最想推进哪件事？\n\n本地演示：尚未读取你的日历，也没有创建日程。";
  }
  if (/灵感|想法|梳理|创意/.test(latest)) {
    return "先把想法留下来，不急着给它打分。\n\n试着回答这三个问题：\n\n· 它想解决生活里的哪个小麻烦？\n· 你希望谁来使用它？\n· 如果今天只能做一个功能，你会选什么？\n\n把零散的片段发给我，下一条我们可以继续展开。\n\n这是本地演示回复，没有调用 AI 服务。";
  }
  if (/你好|hello|嗨/i.test(latest))
    return "你好，我是 Aura。\n\n这里是你的个人工作台，可以用来整理想法、规划日常，也可以从一个简单的问题开始。\n\n当前使用演示回复，无需 API Key。会话记录保存在应用本地；启用 DSH 时，对话也会发送到你配置的工作台服务。\n\n今天，想从哪里开始？";
  return `收到你的想法：\n「${latest.slice(0, 200)}」\n\n我们可以先明确你想得到的结果，再拆成一个容易开始的小步骤。你希望我帮你整理思路，还是列一个行动清单？\n\n这是规则生成的本地演示回复，用来验证发送、逐字显示和会话保存；尚未连接真实模型。`;
}

interface StreamDemoOptions {
  signal?: AbortSignal;
  delay?: number;
}

/** Abortable chunk stream shared by apps and the DSH demo endpoint. */
export async function* streamDemo(
  messages: readonly ChatMessage[],
  { signal, delay = 22 }: StreamDemoOptions = {},
): AsyncGenerator<string> {
  const text = demoReply(messages);
  for (let i = 0; i < text.length; i += 3) {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    yield text.slice(i, i + 3);
  }
}
