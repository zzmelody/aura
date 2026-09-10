const prefix = "AURA_FLOW_INPUT_V1\n";

/**
 * @param {{
 *   task: string;
 *   nodeId: string;
 *   instruction: string;
 *   inputs?: Array<{
 *     stepId: string;
 *     label: string;
 *     sessionId: string;
 *     output: string;
 *   }>;
 * }} value
 */
export function agentPrompt({ task, nodeId, instruction, inputs = [] }) {
  return (
    prefix +
    JSON.stringify({
      task,
      nodeId,
      instruction,
      inputs: inputs.map((item) => ({
        nodeId: item.stepId,
        label: item.label,
        sessionId: item.sessionId,
        output: item.output,
      })),
    })
  );
}
