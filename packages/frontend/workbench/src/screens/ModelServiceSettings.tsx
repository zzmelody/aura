import { ConversationCapabilitySettings } from "./ConversationCapabilitySettings.tsx";
import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Save, Trash2 } from "lucide-react";
import type { AiCustomProvider } from "@aura/protocol/types";
import {
  checkCustomService,
  checkLumina,
  readModelServices,
  saveCustomService,
  saveLumina,
  type ModelServicesState,
} from "../modelServices";

type Feedback = { tone: "ok" | "error" | "info"; text: string } | undefined;

const protocols: Array<{ id: AiCustomProvider["api"]; label: string }> = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
];
const efforts = ["off", "low", "medium", "high", "xhigh", "max"];

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "模型服务设置暂时不可用。";

/**
 * Lumina and custom gateway settings. Keys go to the backend DSH credential
 * store and are never read back; the form only learns whether one is saved.
 */
export function ModelServiceSettings({
  endpoint,
  onUse,
}: {
  endpoint: string;
  onUse(provider: "lumina" | "custom"): void;
}) {
  const [state, setState] = useState<ModelServicesState>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"" | "lumina" | "custom">("");
  const [luminaKey, setLuminaKey] = useState("");
  const [luminaFeedback, setLuminaFeedback] = useState<Feedback>();
  const [customFeedback, setCustomFeedback] = useState<Feedback>();
  const [custom, setCustom] = useState({
    name: "",
    api: "openai-completions" as AiCustomProvider["api"],
    baseURL: "",
    model: "",
    contextWindow: "262144",
    images: true,
    reasoningEffort: "off",
    key: "",
  });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoadError("");
      try {
        const next = await readModelServices(endpoint, signal);
        if (signal?.aborted) return;
        setState(next);
        const saved = next.customModel;
        if (saved?.custom)
          setCustom((draft) => ({
            ...draft,
            name: saved.custom!.name,
            api: saved.custom!.api,
            baseURL: saved.custom!.baseURL,
            model: saved.model,
            contextWindow: String(saved.custom!.contextWindow),
            images: saved.custom!.images,
            reasoningEffort: saved.reasoningEffort,
          }));
      } catch (cause) {
        if (!signal?.aborted) setLoadError(message(cause));
      }
    },
    [endpoint],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  async function run(
    target: "lumina" | "custom",
    work: () => Promise<ModelServicesState>,
    done: (next: ModelServicesState) => Feedback,
  ) {
    const report = target === "lumina" ? setLuminaFeedback : setCustomFeedback;
    setBusy(target);
    report(undefined);
    try {
      const next = await work();
      setState(next);
      report(done(next));
    } catch (cause) {
      report({ tone: "error", text: message(cause) });
    } finally {
      setBusy("");
    }
  }

  // The forms stay usable while status is unknown; a save reports its own error.
  const lumina = state?.lumina ?? {
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    baseURL: "https://lumina.tripo3d.com/v1",
    hasKey: false,
    readOnly: false,
    modelCount: 0,
  };
  const customSaved = state?.customModel;
  const tone = (text: string): NonNullable<Feedback>["tone"] =>
    text.startsWith("连接成功") ? "ok" : text === "未检查" ? "info" : "error";

  return (
    <>
      <ConversationCapabilitySettings endpoint={endpoint} />
      {!state ? (
        <div className="settings-group">
          <div className="settings-row">
            <span className="settings-row-copy">
              <strong>读取模型服务状态</strong>
              <span>
                {loadError
                  ? `${loadError} 下方仍可直接填写保存；若一直失败，请重启 Aura 工作台服务。`
                  : "正在读取后端配置…"}
              </span>
            </span>
            {loadError ? (
              <button
                type="button"
                className="tool-button"
                onClick={() => void load()}
              >
                <RefreshCw size={14} />
                重试
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="settings-group">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-copy">
            <strong>Lumina</strong>
            <span>
              <span
                className={`settings-state ${lumina.hasKey ? "authenticated" : ""}`}
              >
                {lumina.hasKey ? "已配置 Key" : "未配置 Key"}
              </span>
              {` · ${lumina.modelCount} 个对话模型 · `}
              <code>{lumina.baseURL}</code>
            </span>
          </div>
          {lumina.readOnly ? (
            <p className="settings-feedback info">
              Key 由启动环境变量 AURA_LUMINA_API_KEY 提供，此处只读。
            </p>
          ) : (
            <form
              className="settings-endpoint"
              onSubmit={(event) => {
                event.preventDefault();
                if (!luminaKey.trim()) return;
                void run(
                  "lumina",
                  () => saveLumina(endpoint, { key: luminaKey.trim() }, lumina),
                  (next) => {
                    setLuminaKey("");
                    return {
                      tone: tone(next.checks.lumina),
                      text: next.checks.lumina,
                    };
                  },
                );
              }}
            >
              <input
                type="password"
                aria-label="Lumina API Key"
                value={luminaKey}
                onChange={(event) => setLuminaKey(event.target.value)}
                placeholder={
                  lumina.hasKey
                    ? "已保存，输入新 Key 可替换"
                    : "粘贴 Lumina API Key"
                }
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                className="tool-button"
                disabled={busy !== "" || !luminaKey.trim()}
              >
                <KeyRound size={14} />
                保存并同步
              </button>
            </form>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="tool-button"
              disabled={busy !== "" || !lumina.hasKey}
              onClick={() =>
                void run(
                  "lumina",
                  () => checkLumina(endpoint),
                  (next) => ({
                    tone: tone(next.checks.lumina),
                    text: next.checks.lumina,
                  }),
                )
              }
            >
              <RefreshCw size={14} />
              {busy === "lumina" ? "同步中…" : "同步模型列表"}
            </button>
            <button
              type="button"
              className="tool-button accent"
              disabled={!lumina.hasKey}
              onClick={() => {
                onUse("lumina");
                setLuminaFeedback({
                  tone: "ok",
                  text: "新对话将使用 Lumina。",
                });
              }}
            >
              用于对话
            </button>
            {lumina.hasKey && !lumina.readOnly ? (
              <button
                type="button"
                className="tool-button"
                disabled={busy !== ""}
                onClick={() =>
                  void run(
                    "lumina",
                    () => saveLumina(endpoint, { clearKey: true }, lumina),
                    () => ({ tone: "info", text: "已清除 Lumina Key。" }),
                  )
                }
              >
                <Trash2 size={14} />
                清除 Key
              </button>
            ) : null}
          </div>
          {luminaFeedback ? (
            <p
              className={`settings-feedback ${luminaFeedback.tone}`}
              aria-live="polite"
            >
              {luminaFeedback.text}
            </p>
          ) : null}
        </div>
      </div>

      <div className="settings-group">
        <form
          className="settings-row settings-row-stack"
          onSubmit={(event) => {
            event.preventDefault();
            const contextWindow = Number(custom.contextWindow);
            void run(
              "custom",
              async () => {
                await saveCustomService(endpoint, {
                  model: custom.model.trim(),
                  reasoningEffort: custom.reasoningEffort,
                  key: custom.key.trim() || undefined,
                  custom: {
                    name: custom.name.trim() || "自定义 API",
                    api: custom.api,
                    baseURL: custom.baseURL.trim(),
                    images: custom.images,
                    contextWindow,
                  },
                });
                // Checking also syncs the endpoint's model list for the picker.
                return checkCustomService(endpoint);
              },
              (next) => {
                setCustom((draft) => ({ ...draft, key: "" }));
                return {
                  tone: tone(next.checks.model),
                  text: `已保存。${next.checks.model}`,
                };
              },
            );
          }}
        >
          <div className="settings-row-copy">
            <strong>自定义 API</strong>
            <span>
              OpenAI 或 Anthropic 兼容的服务。保存后会同步该服务的模型列表；Key
              只保存在后端。
              {customSaved ? (
                <>
                  {" · "}
                  <span
                    className={`settings-state ${customSaved.hasKey ? "authenticated" : ""}`}
                  >
                    {customSaved.hasKey ? "已配置 Key" : "未配置 Key"}
                  </span>
                </>
              ) : null}
            </span>
          </div>
          <div className="settings-form-grid">
            <label>
              <span>名称</span>
              <input
                value={custom.name}
                onChange={(event) =>
                  setCustom({ ...custom, name: event.target.value })
                }
                placeholder="我的 API"
                maxLength={80}
              />
            </label>
            <label>
              <span>协议</span>
              <select
                value={custom.api}
                onChange={(event) =>
                  setCustom({
                    ...custom,
                    api: event.target.value as AiCustomProvider["api"],
                  })
                }
              >
                {protocols.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              <span>服务地址</span>
              <input
                value={custom.baseURL}
                onChange={(event) =>
                  setCustom({ ...custom, baseURL: event.target.value })
                }
                placeholder="https://your-gateway.example/v1"
                inputMode="url"
                spellCheck={false}
                required
              />
            </label>
            <label>
              <span>默认模型 ID</span>
              <input
                value={custom.model}
                onChange={(event) =>
                  setCustom({ ...custom, model: event.target.value })
                }
                placeholder="例如 deepseek-v4-flash"
                spellCheck={false}
                required
              />
            </label>
            <label>
              <span>思考强度</span>
              <select
                value={custom.reasoningEffort}
                onChange={(event) =>
                  setCustom({ ...custom, reasoningEffort: event.target.value })
                }
              >
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === "off" ? "关闭" : effort}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>上下文长度</span>
              <input
                type="number"
                min={1024}
                max={4000000}
                value={custom.contextWindow}
                onChange={(event) =>
                  setCustom({ ...custom, contextWindow: event.target.value })
                }
                required
              />
            </label>
            <label className="settings-check-field">
              <input
                type="checkbox"
                checked={custom.images}
                onChange={(event) =>
                  setCustom({ ...custom, images: event.target.checked })
                }
              />
              <span>支持图片输入</span>
            </label>
            <label className="wide">
              <span>API Key</span>
              <input
                type="password"
                value={custom.key}
                onChange={(event) =>
                  setCustom({ ...custom, key: event.target.value })
                }
                placeholder={
                  customSaved?.hasKey
                    ? "留空沿用同一地址已保存的 Key"
                    : "粘贴 API Key"
                }
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button
              type="submit"
              className="tool-button"
              disabled={busy !== ""}
            >
              <Save size={14} />
              {busy === "custom" ? "保存中…" : "保存并测试"}
            </button>
            <button
              type="button"
              className="tool-button accent"
              disabled={!customSaved?.hasKey}
              onClick={() => {
                onUse("custom");
                setCustomFeedback({
                  tone: "ok",
                  text: "新对话将使用自定义 API。",
                });
              }}
            >
              用于对话
            </button>
          </div>
          {customFeedback ? (
            <p
              className={`settings-feedback ${customFeedback.tone}`}
              aria-live="polite"
            >
              {customFeedback.text}
            </p>
          ) : null}
        </form>
      </div>
    </>
  );
}
