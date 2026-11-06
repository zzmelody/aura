import { ConversationCapabilitySettings } from "./ConversationCapabilitySettings.tsx";
import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Save, Trash2 } from "lucide-react";
import type { AiCustomProvider } from "@aura/protocol/types";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  modelServiceFeedback,
  type ModelServiceFeedback,
} from "../model-service-messages.ts";
import {
  detailMessage,
  useSettingsDetailsMessages,
} from "./settings-details-messages.ts";
import {
  checkCustomService,
  checkLumina,
  readModelServices,
  saveCustomService,
  saveLumina,
  type ModelServicesState,
} from "../modelServices";

type Feedback = ModelServiceFeedback | undefined;

const protocols: Array<{ id: AiCustomProvider["api"]; label: string }> = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
];
const efforts = ["off", "low", "medium", "high", "xhigh", "max"];

const message = (cause: unknown) =>
  errorMessage(cause, detailMessage("modelSettingsUnavailable"));

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
  const { t, i18n } = useSettingsDetailsMessages();
  const [state, setState] = useState<ModelServicesState>();
  const [loadError, setLoadError] = useState<string | MessageReference>("");
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
  return (
    <>
      <ConversationCapabilitySettings endpoint={endpoint} />
      {!state ? (
        <div className="settings-group">
          <div className="settings-row">
            <span className="settings-row-copy">
              <strong>{t("readModelStatus")}</strong>
              <span>
                {loadError
                  ? t("modelLoadError", { error: messageText(loadError, i18n) })
                  : t("readingConfig")}
              </span>
            </span>
            {loadError ? (
              <button
                type="button"
                className="tool-button"
                onClick={() => void load()}
              >
                <RefreshCw size={14} />
                {t("retry")}
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
                {lumina.hasKey ? t("keyConfigured") : t("keyMissing")}
              </span>
              {" · "}
              {t("modelCount", { count: lumina.modelCount })}
              {" · "}
              <code>{lumina.baseURL}</code>
            </span>
          </div>
          {lumina.readOnly ? (
            <p className="settings-feedback info">{t("environmentKey")}</p>
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
                    return modelServiceFeedback(
                      next.checkDetails?.lumina,
                      next.checks.lumina,
                    );
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
                  lumina.hasKey ? t("replaceKey") : t("pasteLuminaKey")
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
                {t("saveSync")}
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
                  (next) =>
                    modelServiceFeedback(
                      next.checkDetails?.lumina,
                      next.checks.lumina,
                    ),
                )
              }
            >
              <RefreshCw size={14} />
              {busy === "lumina" ? t("syncing") : t("syncModels")}
            </button>
            <button
              type="button"
              className="tool-button accent"
              disabled={!lumina.hasKey}
              onClick={() => {
                onUse("lumina");
                setLuminaFeedback({
                  tone: "ok",
                  text: detailMessage("useLuminaNotice"),
                });
              }}
            >
              {t("useForChats")}
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
                    () => ({
                      tone: "info",
                      text: detailMessage("luminaKeyCleared"),
                    }),
                  )
                }
              >
                <Trash2 size={14} />
                {t("clearKey")}
              </button>
            ) : null}
          </div>
          {luminaFeedback ? (
            <p
              className={`settings-feedback ${luminaFeedback.tone}`}
              aria-live="polite"
            >
              {messageText(luminaFeedback.text, i18n)}
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
                    // Keep the existing persisted default; the display label is localized separately.
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
                const result = modelServiceFeedback(
                  next.checkDetails?.model,
                  next.checks.model,
                );
                return {
                  tone: result.tone,
                  text: detailMessage("savedCheck", {
                    result: result.text,
                  }),
                };
              },
            );
          }}
        >
          <div className="settings-row-copy">
            <strong>{t("customApi")}</strong>
            <span>
              {t("customHint")}
              {customSaved ? (
                <>
                  {" · "}
                  <span
                    className={`settings-state ${customSaved.hasKey ? "authenticated" : ""}`}
                  >
                    {customSaved.hasKey ? t("keyConfigured") : t("keyMissing")}
                  </span>
                </>
              ) : null}
            </span>
          </div>
          <div className="settings-form-grid">
            <label>
              <span>{t("name")}</span>
              <input
                value={custom.name}
                onChange={(event) =>
                  setCustom({ ...custom, name: event.target.value })
                }
                placeholder={t("myApi")}
                maxLength={80}
              />
            </label>
            <label>
              <span>{t("protocol")}</span>
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
              <span>{t("serviceUrl")}</span>
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
              <span>{t("modelId")}</span>
              <input
                value={custom.model}
                onChange={(event) =>
                  setCustom({ ...custom, model: event.target.value })
                }
                placeholder={t("modelExample")}
                spellCheck={false}
                required
              />
            </label>
            <label>
              <span>{t("reasoning")}</span>
              <select
                value={custom.reasoningEffort}
                onChange={(event) =>
                  setCustom({ ...custom, reasoningEffort: event.target.value })
                }
              >
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === "off" ? t("off") : effort}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("contextWindow")}</span>
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
              <span>{t("images")}</span>
            </label>
            <label className="wide">
              <span>API Key</span>
              <input
                type="password"
                value={custom.key}
                onChange={(event) =>
                  setCustom({ ...custom, key: event.target.value })
                }
                placeholder={customSaved?.hasKey ? t("keepKey") : t("pasteKey")}
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
              {busy === "custom" ? t("saving") : t("saveTest")}
            </button>
            <button
              type="button"
              className="tool-button accent"
              disabled={!customSaved?.hasKey}
              onClick={() => {
                onUse("custom");
                setCustomFeedback({
                  tone: "ok",
                  text: detailMessage("useCustomNotice"),
                });
              }}
            >
              {t("useForChats")}
            </button>
          </div>
          {customFeedback ? (
            <p
              className={`settings-feedback ${customFeedback.tone}`}
              aria-live="polite"
            >
              {messageText(customFeedback.text, i18n)}
            </p>
          ) : null}
        </form>
      </div>
    </>
  );
}
