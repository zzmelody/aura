import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  AiConfigurationError,
  readAiServices,
  writeAiServices,
  saveModelSettings,
  saveDiscoveredCatalog,
  parseModelSettings,
  luminaSettings,
  secret,
  LUMINA_BASE_URL,
  LUMINA_CREDENTIAL,
  type AiServiceDocument,
  type CodexSubscriptionAuth,
} from "@aura/dsh-auth";
import { probeModelConnection, modelProbeFailure } from "./model-probe.ts";
import { isChatModelId } from "@aura/protocol/models";
import type { TripoService } from "@aura/tripo";
import type { RuntimeConfig } from "./types.ts";

export interface AiServicesPort {
  settings(): Promise<unknown>;
  saveModel(source: unknown): Promise<unknown>;
  saveTripo(source: unknown): Promise<unknown>;
  saveLumina(source: unknown): Promise<unknown>;
  checkLumina(signal: AbortSignal): Promise<unknown>;
  checkModel(signal: AbortSignal): Promise<unknown>;
  refreshModels(signal: AbortSignal): Promise<unknown>;
  checkTripo(signal: AbortSignal): Promise<unknown>;
  logout(): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Runtime-owned configuration boundary. Secrets go to DSH or Tripo's backend file only. */
export class AiServices implements AiServicesPort {
  private writes: Promise<unknown> = Promise.resolve();
  private checks = { model: "未检查", tripo: "未检查", lumina: "未检查" };
  private checkRuns = { model: 0, tripo: 0 };
  // Explicit fields: Node's strip-only TypeScript rejects parameter properties.
  private config: RuntimeConfig;
  private auth: CodexSubscriptionAuth;
  private tripo: TripoService;
  private busy: () => Promise<boolean>;
  constructor(
    config: RuntimeConfig,
    auth: CodexSubscriptionAuth,
    tripo: TripoService,
    busy: () => Promise<boolean> = async () => false,
  ) {
    this.config = config;
    this.auth = auth;
    this.tripo = tripo;
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
      this.config.tripoRegion,
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
    await this.tripo.refresh();
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
      tripo: {
        ...this.tripo.status(),
        readOnly: Boolean(process.env.TRIPO_API_KEY?.trim()),
      },
      codex: {
        state: auth.state,
        ...("message" in auth ? { message: auth.message } : {}),
        ...("userCode" in auth ? { userCode: auth.userCode } : {}),
        ...("prompt" in auth && auth.prompt
          ? { prompt: auth.prompt.message }
          : {}),
      },
      checks: { ...this.checks },
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
        );
      const parsed = parseModelSettings(source);
      if (parsed.mode === "lumina")
        throw new AiConfigurationError("请通过 Lumina 设置保存。");
      if (parsed.mode === "codex") {
        try {
          await this.auth.validateModel(parsed.model, parsed.reasoningEffort);
        } catch {
          throw new AiConfigurationError(
            "Codex 模型或思考强度不可用，请检查模型 ID。",
          );
        }
      }
      await saveModelSettings(
        this.config.root,
        this.auth.ctx.credentials,
        source,
        this.config.codexModel,
        this.config.tripoRegion,
      );
      this.checks.model = "未检查";
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
        throw new AiConfigurationError("Lumina 设置无效。");
      if (
        (source.key !== undefined || source.clearKey) &&
        process.env[LUMINA_CREDENTIAL]?.trim()
      )
        throw new AiConfigurationError(
          "Lumina Key 由启动环境提供，请先移除环境变量再修改。",
        );
      if (source.clearKey && (await this.busy()))
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再清除密钥。",
        );
      const { select, ...rest } = source;
      const previous = await readAiServices(
        this.config.root,
        this.config.codexModel,
        this.config.tripoRegion,
      );
      const saved = await saveModelSettings(
        this.config.root,
        this.auth.ctx.credentials,
        { mode: "lumina", ...rest },
        this.config.codexModel,
        this.config.tripoRegion,
      );
      // saveModelSettings selects Lumina; restore the prior selection unless asked.
      if (!select && previous.model.mode !== "lumina")
        await writeAiServices(this.config.root, {
          ...saved,
          model: previous.model,
        });
      this.checks.lumina = "未检查";
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
        this.config.tripoRegion,
      );
      this.checks.lumina = `连接成功，已同步 ${chat.length} 个对话模型`;
    } catch {
      this.checks.lumina = "连接失败，请检查 Key 和网络";
    }
  }
  async saveTripo(source: unknown) {
    return this.serialize(async () => {
      if (
        !object(source) ||
        Object.keys(source).some(
          (key) => !["region", "key", "clearKey"].includes(key),
        ) ||
        !["global", "china"].includes(String(source.region)) ||
        (source.clearKey !== undefined &&
          typeof source.clearKey !== "boolean") ||
        (source.clearKey === true && source.key !== undefined)
      )
        throw new AiConfigurationError("Tripo 设置无效。");
      if (process.env.TRIPO_API_KEY?.trim())
        throw new AiConfigurationError(
          "Tripo Key 由启动环境提供，请先移除环境变量再修改。",
        );
      if (await this.busy())
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再修改 Tripo 配置。",
        );
      const value = source.key === undefined ? undefined : secret(source.key);
      if (value && value.length > 256)
        throw new AiConfigurationError("Tripo 密钥过长。");
      const document = await readAiServices(
        this.config.root,
        this.config.codexModel,
        this.config.tripoRegion,
      );
      const previous = await readFile(this.config.tripoCredentialPath).catch(
        (error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      const storeKey = async (bytes?: Uint8Array) => {
        if (!bytes) {
          await unlink(this.config.tripoCredentialPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          return;
        }
        const temporary = `${this.config.tripoCredentialPath}.${randomUUID()}.tmp`;
        await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await rename(temporary, this.config.tripoCredentialPath);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      };
      if (source.clearKey || value)
        await storeKey(source.clearKey ? undefined : Buffer.from(value!));
      try {
        await writeAiServices(this.config.root, {
          ...document,
          tripoRegion: source.region as "global" | "china",
        });
      } catch (error) {
        if (source.clearKey || value) await storeKey(previous);
        throw error;
      }
      this.checks.tripo = "未检查";
      return this.settings();
    });
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
          throw new AiConfigurationError("请先保存模型密钥。");
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
            this.config.tripoRegion,
          );
          this.checks.model = `已获取 ${models.filter(({ id }) => isChatModelId(id)).length} 个模型；尚未测试模型请求。`;
        } catch {
          this.checks.model = "模型列表获取失败；可手填模型 ID 后测试连接。";
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
        this.checks.model = `测试成功 · ${document.model.model} · ${Math.round(performance.now() - started)} ms · 回复：${reply}`;
      } catch (error) {
        this.checks.model = `测试失败 · ${document.model.model} · ${modelProbeFailure(error, signal)}`;
      }
      this.checkRuns.model++;
      return this.settings();
    });
  }
  async checkTripo(signal: AbortSignal) {
    return this.serialize(async () => {
      signal.throwIfAborted();
      try {
        await this.tripo.checkConnection(signal);
        this.checks.tripo = "连接成功";
      } catch {
        this.checks.tripo = "连接失败，请检查地区、密钥和网络";
      }
      this.checkRuns.tripo++;
      return this.settings();
    });
  }
  async logout() {
    return this.serialize(async () => {
      if (await this.busy())
        throw new AiConfigurationError(
          "仍有制作任务，请结束任务后再退出模型账号。",
        );
      await this.auth.logout();
      this.checks.model = "未检查";
      return this.settings();
    });
  }
}
