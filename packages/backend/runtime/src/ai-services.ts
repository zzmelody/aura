import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  AiConfigurationError,
  readAiServices,
  writeAiServices,
  saveModelSettings,
  saveDiscoveredCatalog,
  parseModelSettings,
  luminaSettings,
  LUMINA_BASE_URL,
  LUMINA_CREDENTIAL,
  type AiServiceDocument,
  type CodexSubscriptionAuth,
} from "@aura/dsh-auth";
import {
  probeModelConnection,
  modelProbeFailure,
  modelProbeFailureCode,
} from "./model-probe.ts";
import type { ModelServiceCheck } from "@aura/protocol/model-checks";
import { isChatModelId } from "@aura/protocol/models";
import type { RuntimeConfig } from "./types.ts";

export interface AiServicesPort {
  settings(): Promise<unknown>;
  saveModel(source: unknown): Promise<unknown>;
  saveLumina(source: unknown): Promise<unknown>;
  checkLumina(signal: AbortSignal): Promise<unknown>;
  checkModel(signal: AbortSignal): Promise<unknown>;
  refreshModels(signal: AbortSignal): Promise<unknown>;
  logout(): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Runtime-owned configuration boundary. Secrets go to DSH. */
export class AiServices implements AiServicesPort {
  private writes: Promise<unknown> = Promise.resolve();
  private checks = { model: "未检查", lumina: "未检查" };
  private checkDetails: Record<"model" | "lumina", ModelServiceCheck> = {
    model: { code: "unchecked" },
    lumina: { code: "unchecked" },
  };
  private checkRuns = { model: 0 };
  // Explicit fields: Node's strip-only TypeScript rejects parameter properties.
  private config: RuntimeConfig;
  private auth: CodexSubscriptionAuth;
  private busy: () => Promise<boolean>;
  constructor(
    config: RuntimeConfig,
    auth: CodexSubscriptionAuth,
    busy: () => Promise<boolean> = async () => false,
  ) {
    this.config = config;
    this.auth = auth;
    this.busy = busy;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }
  async settings() {
    const document = await readAiServices(
      this.config.root,
      this.config.codexModel,
    );
    const auth = await this.auth.status();
    const route = document.selectedRoute
      ? document.routes[document.selectedRoute]
      : undefined;
    const hasKey = route
      ? (
          await this.auth.ctx.credentials.describe(
            credentialRef(route.credential),
          )
        ).configured
      : false;
    const lumina = luminaSettings(document);
    const luminaKey = await this.auth.ctx.credentials.describe(
      credentialRef(LUMINA_CREDENTIAL),
    );
    return {
      model: {
        ...document.model,
        hasKey:
          document.model.mode === "lumina" ? luminaKey.configured : hasKey,
        configured:
          document.model.mode === "codex"
            ? auth.state === "authenticated"
            : document.model.mode === "lumina"
              ? luminaKey.configured
              : Boolean(route && hasKey),
      },
      lumina: {
        model: lumina.model,
        reasoningEffort: lumina.reasoningEffort,
        baseURL: LUMINA_BASE_URL,
        hasKey: luminaKey.configured,
        // A launch-environment key wins over the store and cannot be edited here.
        readOnly: Boolean(process.env[LUMINA_CREDENTIAL]?.trim()),
        modelCount: lumina.models.length,
      },
      ...(route ? { customModel: { ...route.settings, hasKey } } : {}),
      codexModel:
        document.codex ??
        (document.model.mode === "codex"
          ? document.model
          : {
              mode: "codex",
              model: this.config.codexModel,
              reasoningEffort: "xhigh",
            }),
      codex: {
        state: auth.state,
        ...("message" in auth ? { message: auth.message } : {}),
        ...("userCode" in auth ? { userCode: auth.userCode } : {}),
        ...("prompt" in auth && auth.prompt
          ? { prompt: auth.prompt.message }
          : {}),
      },
      checks: { ...this.checks },
      checkDetails: structuredClone(this.checkDetails),
      checkRuns: { ...this.checkRuns },
      catalog: {
        codex: (await this.auth.ctx.llm.listModels("openai-codex"))
          .map(({ id }) => id)
          .slice(0, 64),
        custom: (route?.catalog ?? []).slice(0, 128),
        customBaseURL: route?.settings.custom?.baseURL ?? "",
        customApi: route?.settings.custom?.api ?? "",
      },
    };
  }
  async saveModel(source: unknown) {
    return this.serialize(async () => {
      if (object(source) && source.clearKey && (await this.busy()))
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再清除密钥。",
          { details: { code: "ai_busy_clear_key" } },
        );
      const parsed = parseModelSettings(source);
      if (parsed.mode === "lumina")
        throw new AiConfigurationError("请通过 Lumina 设置保存。", {
          details: { code: "ai_lumina_settings_required" },
        });
      if (parsed.mode === "codex") {
        try {
          await this.auth.validateModel(parsed.model, parsed.reasoningEffort);
        } catch {
          throw new AiConfigurationError(
            "Codex 模型或思考强度不可用，请检查模型 ID。",
            { details: { code: "model_configuration_invalid" } },
          );
        }
      }
      await saveModelSettings(
        this.config.root,
        this.auth.ctx.credentials,
        source,
        this.config.codexModel,
      );
      this.checks.model = "未检查";
      this.checkDetails.model = { code: "unchecked" };
      return this.settings();
    });
  }
  /** Saves the Lumina key and default model; `select` also makes it the configured mode. */
  async saveLumina(source: unknown) {
    return this.serialize(async () => {
      if (
        !object(source) ||
        Object.keys(source).some(
          (key) =>
            !["model", "reasoningEffort", "key", "clearKey", "select"].includes(
              key,
            ),
        ) ||
        (source.select !== undefined && typeof source.select !== "boolean")
      )
        throw new AiConfigurationError("Lumina 设置无效。", {
          details: { code: "ai_custom_invalid" },
        });
      if (
        (source.key !== undefined || source.clearKey) &&
        process.env[LUMINA_CREDENTIAL]?.trim()
      )
        throw new AiConfigurationError(
          "Lumina Key 由启动环境提供，请先移除环境变量再修改。",
          { details: { code: "ai_environment_key_readonly" } },
        );
      if (source.clearKey && (await this.busy()))
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再清除密钥。",
          { details: { code: "ai_busy_clear_key" } },
        );
      const { select, ...rest } = source;
      const previous = await readAiServices(
        this.config.root,
        this.config.codexModel,
      );
      const saved = await saveModelSettings(
        this.config.root,
        this.auth.ctx.credentials,
        { mode: "lumina", ...rest },
        this.config.codexModel,
      );
      // saveModelSettings selects Lumina; restore the prior selection unless asked.
      if (!select && previous.model.mode !== "lumina")
        await writeAiServices(this.config.root, {
          ...saved,
          model: previous.model,
        });
      this.checks.lumina = "未检查";
      this.checkDetails.lumina = { code: "unchecked" };
      if (rest.key !== undefined)
        await this.discoverLumina(AbortSignal.timeout(15_000));
      return this.settings();
    });
  }
  async checkLumina(signal: AbortSignal) {
    return this.serialize(async () => {
      await this.discoverLumina(signal);
      return this.settings();
    });
  }
  /** Lists Lumina's models through DSH discovery and keeps only chat models. */
  private async discoverLumina(signal: AbortSignal) {
    const key = await this.auth.ctx.credentials.resolve(
      credentialRef(LUMINA_CREDENTIAL),
    );
    if (!key) {
      this.checks.lumina = "请先保存 Lumina Key";
      this.checkDetails.lumina = { code: "key_required" };
      return;
    }
    try {
      const models = await this.auth.ctx.llm.discoverModels(
        "llm-pi-ai",
        {
          baseURL: LUMINA_BASE_URL,
          api: "openai-completions",
          apiKey: key.value,
        },
        signal,
      );
      const chat = models.map(({ id }) => id).filter(isChatModelId);
      await saveDiscoveredCatalog(
        this.config.root,
        "lumina",
        chat,
        this.config.codexModel,
      );
      this.checks.lumina = `连接成功，已同步 ${chat.length} 个对话模型`;
      this.checkDetails.lumina = { code: "models_synced", count: chat.length };
    } catch {
      this.checks.lumina = "连接失败，请检查 Key 和网络";
      this.checkDetails.lumina = { code: "discovery_failed" };
    }
  }
  async refreshModels(signal: AbortSignal) {
    return this.serialize(async () => {
      const document: AiServiceDocument = await readAiServices(
        this.config.root,
        this.config.codexModel,
      );
      if (document.model.mode === "lumina") {
        await this.discoverLumina(signal);
        this.checks.model = this.checks.lumina;
        this.checkDetails.model = this.checkDetails.lumina;
      } else {
        const route = document.selectedRoute
          ? document.routes[document.selectedRoute]
          : undefined;
        const key = route
          ? await this.auth.ctx.credentials.resolve(
              credentialRef(route.credential),
            )
          : undefined;
        if (!route || !key)
          throw new AiConfigurationError("请先保存模型密钥。", {
            details: { code: "ai_key_required" },
          });
        try {
          const models = await this.auth.ctx.llm.discoverModels(
            "llm-pi-ai",
            {
              baseURL: route.settings.custom!.baseURL,
              api: route.settings.custom!.api,
              ...(key ? { apiKey: key.value } : {}),
            },
            signal,
          );
          await saveDiscoveredCatalog(
            this.config.root,
            document.selectedRoute!,
            models
              .map(({ id }) => id)
              .filter(isChatModelId)
              .slice(0, 500),
            this.config.codexModel,
          );
          this.checks.model = `已获取 ${models.filter(({ id }) => isChatModelId(id)).length} 个模型；尚未测试模型请求。`;
          this.checkDetails.model = {
            code: "models_listed",
            count: models.filter(({ id }) => isChatModelId(id)).length,
          };
        } catch {
          this.checks.model = "模型列表获取失败；可手填模型 ID 后测试连接。";
          this.checkDetails.model = { code: "catalog_failed" };
        }
      }
      return this.settings();
    });
  }
  async checkModel(signal: AbortSignal) {
    return this.serialize(async () => {
      const document = await readAiServices(
        this.config.root,
        this.config.codexModel,
      );
      const started = performance.now();
      try {
        if (
          document.model.mode === "codex" &&
          (await this.auth.status()).state !== "authenticated"
        )
          throw { status: 401 };
        const reply = await probeModelConnection(
          document,
          this.config.credentialPath,
          signal,
        );
        const elapsedMs = Math.round(performance.now() - started);
        this.checks.model = `测试成功 · ${document.model.model} · ${elapsedMs} ms · 回复：${reply}`;
        this.checkDetails.model = {
          code: "probe_succeeded",
          model: document.model.model,
          elapsedMs,
          reply,
        };
      } catch (error) {
        this.checks.model = `测试失败 · ${document.model.model} · ${modelProbeFailure(error, signal)}`;
        this.checkDetails.model = {
          code: "probe_failed",
          model: document.model.model,
          reason: modelProbeFailureCode(error, signal),
        };
      }
      this.checkRuns.model++;
      return this.settings();
    });
  }
  async logout() {
    return this.serialize(async () => {
      if (await this.busy())
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再退出模型账号。",
          { details: { code: "ai_busy_logout" } },
        );
      await this.auth.logout();
      this.checks.model = "未检查";
      this.checkDetails.model = { code: "unchecked" };
      return this.settings();
    });
  }
}
