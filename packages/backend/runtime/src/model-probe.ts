import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { MessageId, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import type { ModelProbeFailureCode } from "@aura/protocol/model-checks";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import {
  customProfiles,
  selectedAgentConfig,
  codexProviderProfile,
  type AiServiceDocument,
} from "@aura/dsh-auth";

/** A short real inference through the same DSH profiles/credential store as creation. */
export async function probeModelConnection(
  document: AiServiceDocument,
  credentialPath: string,
  signal: AbortSignal,
): Promise<string> {
  const ctx = new Context();
  try {
    signal.throwIfAborted();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalCredentialProvider, {
      path: credentialPath,
      watch: false,
    });
    await ctx.plugin(PiAiAdapter, {
      providers:
        document.model.mode === "codex"
          ? { "openai-codex": await codexProviderProfile() }
          : customProfiles(document),
    });
    const selected = selectedAgentConfig(document);
    let reply = "";
    for await (const chunk of ctx.llm.stream({
      provider: selected.provider,
      model: selected.model,
      ...(document.model.reasoningEffort === "off"
        ? {}
        : {
            reasoningEffort: ReasoningEffortId(document.model.reasoningEffort),
          }),
      messages: [
        {
          id: MessageId("aura-model-connection-test"),
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "Reply with only OK." }],
        },
      ],
      signal,
    })) {
      if (chunk.type === "text-delta" && reply.length < 80)
        reply = (reply + chunk.text).slice(0, 80);
      if (
        chunk.type === "finish" &&
        (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")
      )
        throw chunk.reason.failure;
    }
    if (reply.trim()) return reply.trim();
    throw { code: "empty_response", message: "No visible response" };
  } finally {
    await ctx.fiber.dispose();
  }
}

/** Do not expose raw provider errors: they can contain request headers or credentials. */
export function modelProbeFailureCode(
  error: unknown,
  signal: AbortSignal,
): ModelProbeFailureCode {
  const value =
    error && typeof error === "object"
      ? (error as { status?: number; code?: string; message?: string })
      : {};
  // Some DSH adapters retain the HTTP code only in the provider message.
  // Inspect it for classification, but never return that message to the UI.
  const status =
    value.status ??
    Number(
      /(?:^|\bHTTP\s+|\bstatus\s*[:=]?\s*)(401|403|404|429)\b/i.exec(
        value.message ?? "",
      )?.[1],
    );
  if (signal.aborted || /timeout|timed.?out/i.test(value.code ?? ""))
    return "timeout";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (
    value.code === "empty_response" ||
    /empty.?response|no (?:text|content|assistant)|no.*content.*block/i.test(
      value.message ?? "",
    )
  )
    return "empty_response";
  if (/resolve|config|model.?not.?found|unsupported/i.test(value.code ?? ""))
    return "unsupported";
  return "request_failed";
}

const failureMessages: Record<ModelProbeFailureCode, string> = {
  timeout: "请求超时或已取消，请检查网络后重试。",
  authentication: "认证失败，请检查模型密钥或重新登录。",
  permission: "没有权限使用所选模型。",
  not_found: "模型或 API 地址不存在，请检查地址、协议和模型 ID。",
  rate_limit: "服务限流或额度不足，请检查账户后重试。",
  empty_response: "服务没有返回有效文本，请检查模型和协议。",
  unsupported: "所选模型或参数不受支持，请检查模型和思考强度。",
  request_failed: "模型请求失败，请检查协议、地址、网络及服务状态。",
};

/** Legacy human-readable response remains compatible with older clients. */
export function modelProbeFailure(error: unknown, signal: AbortSignal): string {
  return failureMessages[modelProbeFailureCode(error, signal)];
}
