import { CodedFlowError } from "@aura/protocol/errors";

export function agentFailure(message?: string): CodedFlowError {
  if (message === "model_output_limit")
    return new CodedFlowError(
      "model_output_limit: 模型达到输出上限，尚未完成制作结果；请调整模型输出预算后再试。",
      400,
      { code: "model_output_limit" },
    );
  if (/\bbudget_exceeded\b|Budget has been exceeded/iu.test(message ?? ""))
    return new CodedFlowError(
      "model_budget_exceeded: 模型服务额度已用尽，请调整服务额度后再继续制作。",
      402,
      { code: "model_budget_exceeded" },
    );
  // DSH can include raw token-service response bytes in the error cause. Never
  // forward those bytes to Flow storage or the client; give a recovery action.
  if (
    /OAuth refresh failed for openai-codex|OpenAI Codex token refresh/i.test(
      message ?? "",
    )
  )
    return new CodedFlowError(
      "Codex 登录续期失败。请检查网络或代理，在右上角重新登录 Codex 后新建运行。",
      400,
      { code: "codex_refresh_failed" },
    );
  // The DSH catalog lists some API-only models a ChatGPT subscription rejects.
  const unsupported = message?.match(
    /The '([\w.-]{1,80})' model is not supported when using Codex with a ChatGPT account/u,
  )?.[1];
  if (unsupported)
    return new CodedFlowError(
      `模型 ${unsupported} 不支持 Codex 订阅账号，请换一个模型再试。`,
      422,
      { code: "model_codex_unsupported", params: { model: unsupported } },
    );
  const status = message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  return new CodedFlowError(
    status
      ? `DSH 模型请求失败（HTTP ${status}），请查看对应会话。`
      : "DSH Agent 执行失败，请查看对应会话。",
    400,
    status && Number(status) >= 100 && Number(status) <= 599
      ? { code: "model_http_failed", params: { status: Number(status) } }
      : { code: "model_execution_failed" },
  );
}
