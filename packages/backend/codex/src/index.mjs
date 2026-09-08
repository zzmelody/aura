import { Context } from "@deepseek-ai/cordis";
import AuthorizationService from "@deepseek-ai/dsh-authorization";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import { recordKeyFor } from "@deepseek-ai/dsh-llm-pi-ai";

const providerId = "openai-codex";

/** @param {AbortSignal[]} signals @returns {Promise<never>} */
function waitForAbort(signals) {
  return new Promise((_, reject) => {
    /** @type {Array<[AbortSignal, () => void]>} */
    const subscriptions = [];
    const cleanup = () => {
      for (const [signal, listener] of subscriptions)
        signal.removeEventListener("abort", listener);
    };
    /** @param {AbortSignal} signal */
    const abort = (signal) => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    for (const signal of signals) {
      if (signal.aborted) return abort(signal);
      const listener = () => abort(signal);
      subscriptions.push([signal, listener]);
      signal.addEventListener("abort", listener, { once: true });
    }
  });
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
      throw new Error("DSH did not register the openai-codex authorization flow.");
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
    /** @type {import('@aura/protocol/types').CodexAuthStatus} */
    this.state = { state: "signed_out", model };
  }

  /** @returns {Promise<import('@aura/protocol/types').CodexAuthStatus>} */
  async status() {
    if (this.login) return this.state;
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
    /** @type {() => void} */
    let announce = () => {};
    const announced = new Promise((resolve) => {
      announce = () => resolve(undefined);
    });
    /** @type {import('@deepseek-ai/dsh-authorization').AuthorizationInteraction} */
    const interaction = {
      notify: (notice) => {
        this.state = {
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
          const selected = prompt.options.find((option) => option.id === method);
          if (!selected) throw new Error(`DSH OAuth method is unavailable: ${method}`);
          return Promise.resolve(selected.id);
        }
        const signals = [controller.signal];
        if (prompt.signal) signals.push(prompt.signal);
        return waitForAbort(signals);
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
            message: "DSH Codex 登录失败，请重新尝试。",
            model: this.modelId,
          };
      })
      .finally(() => {
        this.login = null;
        this.loginController = null;
        announce();
      });
    await Promise.race([announced, this.login]);
    return this.state;
  }

  /** Cancels login and disposes the DSH composition. */
  async close() {
    this.loginController?.abort();
    await this.ctx.fiber.dispose();
  }
}
