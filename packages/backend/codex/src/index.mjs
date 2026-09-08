import { Context } from "@deepseek-ai/cordis";
import AuthorizationService from "@deepseek-ai/dsh-authorization";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import { recordKeyFor } from "@deepseek-ai/dsh-llm-pi-ai";

const providerId = "openai-codex";

/** Converts provider failures into useful messages without exposing OAuth data. */
/** @param {unknown} error */
function loginErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /device code login is not enabled|device code request failed[^\n]*404/i.test(
      message,
    )
  )
    return "OpenAI 未启用设备码登录，请使用浏览器登录。";
  if (/EADDRINUSE|address already in use|1455.*use/i.test(message))
    return "本机 1455 端口已被占用，无法接收 OpenAI 登录回调。";
  if (/token exchange failed|token exchange error/i.test(message))
    return "已收到登录回调，但 OpenAI 令牌交换失败；请检查网络或代理后重试。";
  if (/state mismatch/i.test(message))
    return "OpenAI 登录回调已过期，请重新开始登录。";
  if (/missing authorization code/i.test(message))
    return "没有收到 OpenAI 授权结果，请重新开始登录。";
  return "DSH Codex 登录失败，请重新尝试。";
}

/** DSH-owned ChatGPT subscription authorization for the openai-codex route. */
export class DshCodexAuthorization {
  /**
   * Builds the DSH credential, authorization and pi-ai adapter composition.
   * @param {{credentialPath: string, model?: string}} options
   * @returns {Promise<DshCodexAuthorization>}
   */
  static async create(options) {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalCredentialProvider, {
      path: options.credentialPath,
      watch: false,
    });
    await ctx.plugin(AuthorizationService);
    await ctx.plugin(PiAiAdapter, {
      providers: {
        [providerId]: {
          reasoning: "medium",
          transport: "sse",
          cacheRetention: "short",
        },
      },
    });
    const instance = new DshCodexAuthorization(
      ctx,
      options.model ?? "gpt-5.6-terra",
    );
    if (!ctx.authorization.describe(instance.key)) {
      await ctx.fiber.dispose();
      throw new Error(
        "DSH did not register the openai-codex authorization flow.",
      );
    }
    return instance;
  }

  /** @param {Context} ctx @param {string} model */
  constructor(ctx, model) {
    this.ctx = ctx;
    this.modelId = model;
    this.key = recordKeyFor(providerId);
    /** @type {Promise<void> | null} */
    this.login = null;
    /** @type {AbortController | null} */
    this.loginController = null;
    /** @type {{resolve: (value: string) => void, reject: (error: unknown) => void} | null} */
    this.pendingPrompt = null;
    /** @type {import('@aura/protocol/types').CodexAuthStatus} */
    this.state = { state: "signed_out", model };
  }

  /** @returns {Promise<import('@aura/protocol/types').CodexAuthStatus>} */
  async status() {
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
  async startLogin(method) {
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
    /** @type {() => void} */
    let announce = () => {};
    const announced = new Promise((resolve) => {
      announce = () => resolve(undefined);
    });
    /** @type {import('@deepseek-ai/dsh-authorization').AuthorizationInteraction} */
    const interaction = {
      notify: (notice) => {
        const previous =
          this.state.state === "pending" ? this.state : undefined;
        this.state = {
          ...previous,
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
          /** @type {Array<[AbortSignal, () => void]>} */
          const subscriptions = [];
          const cleanup = () => {
            for (const [signal, listener] of subscriptions)
              signal.removeEventListener("abort", listener);
            this.pendingPrompt = null;
            if (this.state.state === "pending" && this.state.prompt) {
              const { prompt: _prompt, ...pending } = this.state;
              this.state = { ...pending, message: "正在确认 OpenAI 登录结果…" };
            }
          };
          /** @param {string} value */
          const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          };
          /** @param {unknown} error */
          const finishReject = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          /** @param {AbortSignal} signal */
          const rejectFor = (signal) =>
            finishReject(
              signal.reason ?? new DOMException("Aborted", "AbortError"),
            );
          this.pendingPrompt = {
            resolve: finishResolve,
            reject: finishReject,
          };
          /** @type {Extract<import('@aura/protocol/types').CodexAuthStatus, {state: 'pending'}>} */
          const previous =
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
        if (error?.name === "AbortError")
          this.state = { state: "signed_out", model: this.modelId };
        else
          this.state = {
            state: "error",
            message: loginErrorMessage(error),
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
  /** @param {unknown} input */
  submitLoginInput(input) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value || value.length > 8192)
      throw new Error("授权结果不能为空，且不能超过 8192 个字符。");
    if (!this.pendingPrompt)
      throw new Error("当前没有等待输入的 Codex 登录流程。");
    this.pendingPrompt.resolve(value);
    return this.state;
  }

  /** Cancels the current attempt so another login method can start cleanly. */
  async cancelLogin() {
    if (!this.login) return this.status();
    this.loginController?.abort();
    await this.login;
    return this.state;
  }

  /** Cancels login and disposes the DSH composition. */
  async close() {
    this.loginController?.abort();
    await this.login;
    await this.ctx.fiber.dispose();
  }
}
