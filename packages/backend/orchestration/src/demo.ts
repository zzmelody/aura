/** Deterministic fake-provider output, still executed through real DSH sessions. */
export function flowDemoReply(messages: unknown): string | undefined {
  const prefix = "AURA_FLOW_INPUT_V1\n";
  if (!Array.isArray(messages)) return undefined;
  const input = messages
    .filter((message) => message?.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part: { type?: string }) => part?.type === "text")
              .map((part: { text: string }) => part.text)
              .join("")
          : undefined,
    )
    .reverse()
    .find((text: string | undefined) => text?.startsWith(prefix));
  if (!input) return undefined;
  const { task, nodeId, inputs } = JSON.parse(input.slice(prefix.length)) as {
    task: string;
    nodeId: string;
    inputs: { nodeId: string; sessionId: string; output: string }[];
  };
  if (nodeId === "coordinator")
    return `演示模式 · 最终报告\n\n任务：${task}\n\n${inputs.map((node) => `来源 ${node.nodeId}（${node.sessionId}）\n${node.output}`).join("\n\n")}\n\n下一步：确认约束并选择方案，然后在 Codex 模式中生成真实模型报告。\n本报告由本地规则模型生成，不代表真实研究或验证。`;
  return `演示模式 · ${nodeId}\n\n任务：${task}\n${nodeId === "review" ? "审阅要点：检查权限边界、失败恢复和验收条件。" : "分析要点：明确目标、拆分工作并定义可验证的交付结果。"}\n上游输入：${inputs.map((node) => node.nodeId).join("、") || "无"}\n这是本地规则输出，不包含真实模型研究。`;
}
