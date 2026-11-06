import { CodedFlowError } from "@aura/protocol/errors";
import { Context } from "@deepseek-ai/cordis";
import AuthorizationService, {
  type AuthorizationInteraction,
} from "@deepseek-ai/dsh-authorization";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import LlmRuntime, { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import { recordKeyFor } from "@deepseek-ai/dsh-llm-pi-ai";
import type { CodexAuthStatus } from "@aura/protocol/types";
import { codexProviderProfile } from "./codex-profile.ts";

const providerId = "openai-codex";

/** Converts provider failures into useful messages without exposing OAuth data. */
function loginErrorMessage(error: unknown): CodedFlowError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /device code login is not enabled|device code request failed[^\n]*404/i.test(
      message,
    )
  )
    return new CodedFlowError(
      "OpenAI 未启用设备码登录，请使用浏览器登录。",
      409,
      { code: "auth_device_unavailable" },
    );
  if (/EADDRINUSE|address already in use|1455.*use/i.test(message))
    return new CodedFlowError(
      "本机 1455 端口已被占用，无法接收 OpenAI 登录回调。",
      409,
      { code: "auth_callback_port_busy" },
    );
  if (/token exchange failed|token exchange error/i.test(message))
    return new CodedFlowError(
      "已收到登录回调，但 OpenAI 令牌交换失败；请检查网络或代理后重试。",
      409,
      { code: "auth_token_exchange_failed" },
    );
  if (/state mismatch/i.test(message))
    return new CodedFlowError("OpenAI 登录回调已过期，请重新开始登录。", 409, {
      code: "auth_callback_expired",
    });
  if (/missing authorization code/i.test(message))
    return new CodedFlowError(
      "没有收到 OpenAI 授权结果，请重新开始登录。",
      409,
      { code: "auth_code_missing" },
    );
  return new CodedFlowError("DSH Codex 登录失败，请重新尝试。", 409, {
    code: "auth_login_failed",
  });
}

/** DSH-owned ChatGPT subscription authorization for the openai-codex route. */
export class CodexSubscriptionAuth {
  readonly ctx: Context;
  readonly modelId: string;
  readonly key: ReturnType<typeof recordKeyFor>;
  login: Promise<void> | null;
  loginController: AbortController | null;
  pendingPrompt: {
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  } | null;
  state: CodexAuthStatus;

  /**
   * Builds the DSH credential, authorization and pi-ai adapter composition.
   * @param {{credentialPath: string, model?: string}} options
   * @returns {Promise<CodexSubscriptionAuth>}
   */
  static async create(options: {
    credentialPath: string;
    model?: string;
  }): Promise<CodexSubscriptionAuth> {
    const providerProfile = await codexProviderProfile();
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalCredentialProvider, {
      path: options.credentialPath,
      watch: false,
    });
    await ctx.plugin(AuthorizationService);
    await ctx.plugin(PiAiAdapter, {
      providers: {
        [providerId]: providerProfile,
      },
    });
    const instance = new CodexSubscriptionAuth(
      ctx,
      options.model ?? "gpt-6.1-sol",
    );
    if (!ctx.authorization.describe(instance.key)) {
      await ctx.fiber.dispose();
      throw new Error(
        "DSH did not register the openai-codex authorization flow.",
      );
    }
    return instance;
  }

  constructor(ctx: Context, model: string) {
    this.ctx = ctx;
    this.modelId = model;
    this.key = recordKeyFor(providerId);
    this.login = null;
    this.loginController = null;
    this.pendingPrompt = null;
    this.state = { state: "signed_out", model };
  }

  async status(): Promise<CodexAuthStatus> {
    if (this.login || this.state.state === "error") return this.state;
    try {
      const info = await this.ctx.credentials.describeRecord(this.key);
      this.state = info.configured
        ? { state: "authenticated", model: this.modelId }
        : { state: "signed_out", model: this.modelId };
    } catch {
      this.state = {
        state: "error",
        message: "无法读取 DSH 的 Codex 登录状态。",
        messageDetails: { code: "auth_status_unavailable" },
        model: this.modelId,
      };
    }
    return this.state;
  }

  /**
   * Starts DSH's openai-codex OAuth authorization flow.
   * @param {"browser" | "device_code"} method
   * @returns {Promise<import('@aura/protocol/types').CodexAuthStatus>}
   */
  async startLogin(
    method: "browser" | "device_code",
  ): Promise<CodexAuthStatus> {
    if (this.login) return this.state;
    const controller = new AbortController();
    this.loginController = controller;
    this.state = { state: "pending", method, model: this.modelId };
    const callbackHostWasSet = Object.hasOwn(
      process.env,
      "PI_OAUTH_CALLBACK_HOST",
    );
    const callbackHostBefore = process.env.PI_OAUTH_CALLBACK_HOST;
    if (method === "browser" && !callbackHostWasSet)
      process.env.PI_OAUTH_CALLBACK_HOST = "localhost";
    let announce: () => void = () => {};
    const announced = new Promise<void>((resolve) => {
      announce = () => resolve(undefined);
    });
    const interaction: AuthorizationInteraction = {
      notify: (notice) => {
        const previous =
          this.state.state === "pending" ? this.state : undefined;
        const { messageDetails: _messageDetails, ...previousStatus } =
          previous ?? {};
        this.state = {
          ...previousStatus,
          state: "pending",
          method,
          ...(notice.url === undefined
            ? {}
            : notice.code === undefined
              ? { authUrl: notice.url }
              : { verificationUri: notice.url }),
          ...(notice.code === undefined ? {} : { userCode: notice.code }),
          message: notice.message,
          model: this.modelId,
        };
        if (notice.url) announce();
      },
      prompt: (prompt) => {
        if (prompt.kind === "select") {
          const selected = prompt.options.find(
            (option) => option.id === method,
          );
          if (!selected)
            throw new Error(`DSH OAuth method is unavailable: ${method}`);
          return Promise.resolve(selected.id);
        }
        return new Promise((resolve, reject) => {
          let settled = false;
          const subscriptions: Array<[AbortSignal, () => void]> = [];
          const cleanup = () => {
            for (const [signal, listener] of subscriptions)
              signal.removeEventListener("abort", listener);
            this.pendingPrompt = null;
            if (this.state.state === "pending" && this.state.prompt) {
              const { prompt: _prompt, ...pending } = this.state;
              this.state = {
                ...pending,
                message: "正在确认 OpenAI 登录结果…",
                messageDetails: { code: "auth_login_confirming" },
              };
            }
          };
          const finishResolve = (value: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          };
          const finishReject = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const rejectFor = (signal: AbortSignal) =>
            finishReject(
              signal.reason ?? new DOMException("Aborted", "AbortError"),
            );
          this.pendingPrompt = {
            resolve: finishResolve,
            reject: finishReject,
          };
          const previous: Extract<CodexAuthStatus, { state: "pending" }> =
            this.state.state === "pending"
              ? this.state
              : { state: "pending", method, model: this.modelId };
          this.state = {
            ...previous,
            prompt: {
              kind: prompt.kind,
              message: prompt.message,
              ...(prompt.placeholder === undefined
                ? {}
                : { placeholder: prompt.placeholder }),
            },
          };
          for (const signal of [controller.signal, prompt.signal]) {
            if (!signal) continue;
            if (signal.aborted) {
              rejectFor(signal);
              return;
            }
            const listener = () => rejectFor(signal);
            subscriptions.push([signal, listener]);
            signal.addEventListener("abort", listener, { once: true });
          }
        });
      },
    };
    this.login = this.ctx.authorization
      .begin({
        key: this.key,
        method: "oauth",
        interaction,
        signal: controller.signal,
      })
      .then((outcome) => {
        this.state =
          outcome.status === "authorized"
            ? { state: "authenticated", model: this.modelId }
            : { state: "signed_out", model: this.modelId };
      })
      .catch((error) => {
        const failure = loginErrorMessage(error);
        if (error instanceof Error && error.name === "AbortError")
          this.state = { state: "signed_out", model: this.modelId };
        else
          this.state = {
            state: "error",
            message: failure.message,
            messageDetails: failure.details,
            model: this.modelId,
          };
      })
      .finally(() => {
        this.pendingPrompt = null;
        this.login = null;
        this.loginController = null;
        if (!callbackHostWasSet || callbackHostBefore === undefined)
          delete process.env.PI_OAUTH_CALLBACK_HOST;
        else process.env.PI_OAUTH_CALLBACK_HOST = callbackHostBefore;
        announce();
      });
    await Promise.race([announced, this.login]);
    return this.state;
  }

  /** Supplies the manual callback URL/code requested by DSH's browser flow. */
  submitLoginInput(input: unknown): CodexAuthStatus {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value || value.length > 8192)
      throw new CodedFlowError(
        "授权结果不能为空，且不能超过 8192 个字符。",
        409,
        { code: "auth_result_invalid" },
      );
    if (!this.pendingPrompt)
      throw new CodedFlowError("当前没有等待输入的 Codex 登录流程。", 409, {
        code: "auth_no_pending_login",
      });
    this.pendingPrompt.resolve(value);
    return this.state;
  }

  /** Cancels the current attempt so another login method can start cleanly. */
  async cancelLogin(): Promise<CodexAuthStatus> {
    if (!this.login) return this.status();
    this.loginController?.abort();
    await this.login;
    return this.state;
  }

  async logout(): Promise<void> {
    await this.cancelLogin();
    await this.ctx.credentials.deleteRecord(this.key);
    this.state = { state: "signed_out", model: this.modelId };
  }

  async validateModel(model: string, reasoningEffort: string): Promise<void> {
    await this.ctx.llm.resolveCallConfig({
      provider: providerId,
      model,
      reasoningEffort: ReasoningEffortId(reasoningEffort),
    });
  }

  /** Cancels login and disposes the DSH composition. */
  async close(): Promise<void> {
    this.loginController?.abort();
    await this.login;
    await this.ctx.fiber.dispose();
  }
}
