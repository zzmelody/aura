const flowPrefix = "AURA_FLOW_INPUT_V1\n";
const historyPrefix = "AURA_HISTORY_V1\n";
const runtimeContextPrefix = "Current runtime context.";

function messageText(message: unknown): string | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "user" ||
    !("content" in message)
  )
    return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/** Deterministic fake-provider output, still executed through real DSH sessions. */
export function flowDemoReply(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const userMessages = messages
    .map(messageText)
    .filter((text): text is string => typeof text === "string");
  const input = [...userMessages]
    .reverse()
    .find((text) => text.startsWith(flowPrefix));
  if (!input) {
    if (userMessages.some((text) => text.startsWith(historyPrefix)))
      return undefined;
    const prompt = [...userMessages]
      .reverse()
      .find((text) => text.trim() && !text.startsWith(runtimeContextPrefix));
    if (!prompt) return undefined;
    return `演示模式 · Agent\n\n已处理以下任务：\n${prompt.trim()}\n\n这是本地规则输出，不包含真实模型研究。`;
  }
  const { task, nodeId, inputs } = JSON.parse(
    input.slice(flowPrefix.length),
  ) as {
    task: string;
    nodeId: string;
    inputs: Array<{ nodeId: string; sessionId: string; output: string }>;
  };
  if (nodeId === "coordinator")
    return `演示模式 · 最终报告\n\n任务：${task}\n\n${inputs.map((node) => `来源 ${node.nodeId}（${node.sessionId}）\n${node.output}`).join("\n\n")}\n\n下一步：确认约束并选择方案，然后在 Codex 模式中生成真实模型报告。\n本报告由本地规则模型生成，不代表真实研究或验证。`;
  return `演示模式 · ${nodeId}\n\n任务：${task}\n${nodeId === "review" ? "审阅要点：检查权限边界、失败恢复和验收条件。" : "分析要点：明确目标、拆分工作并定义可验证的交付结果。"}\n上游输入：${inputs.map((node) => node.nodeId).join("、") || "无"}\n这是本地规则输出，不包含真实模型研究。`;
}
