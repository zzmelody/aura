import React, { useEffect, useState } from "react";
import { Save } from "lucide-react";
import type { CodingCapabilities } from "@aura/protocol/types";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  detailMessage,
  useSettingsDetailsMessages,
} from "./settings-details-messages.ts";
import {
  readCodingCapabilities,
  saveCodingCapabilities,
} from "../features/coding/api.ts";

type Feedback =
  | { tone: "ok" | "error" | "info"; text: string | MessageReference }
  | undefined;

/** One settings row with a trailing DSH switch, matching the plugin list. */
function SwitchRow({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  hint?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <label className="dsh-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={title}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span aria-hidden="true" />
      </label>
    </div>
  );
}

export function ConversationCapabilitySettings({
  endpoint,
}: {
  endpoint: string;
}) {
  const { t, i18n } = useSettingsDetailsMessages();
  const [state, setState] = useState<CodingCapabilities>();
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [acknowledgeUnknown, setAcknowledgeUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  useEffect(() => {
    let current = true;
    void readCodingCapabilities(endpoint)
      .then((value) => {
        if (current) setState(value);
      })
      .catch(() => {
        if (current)
          setFeedback({
            tone: "error",
            text: detailMessage("capabilitiesUnavailable"),
          });
      });
    return () => {
      current = false;
    };
  }, [endpoint]);
  async function save() {
    if (!state) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const { revision, autoCompact, web, subagents, maxRequests } = state;
      const next = await saveCodingCapabilities(endpoint, {
        revision,
        autoCompact,
        web,
        subagents,
        maxRequests,
        clearKey,
        acknowledgeUnknown,
        ...(key ? { key } : {}),
      });
      setState(next);
      setKey("");
      setClearKey(false);
      setAcknowledgeUnknown(false);
      setFeedback({ tone: "ok", text: detailMessage("capabilitiesSaved") });
    } catch (cause) {
      setFeedback({
        tone: "error",
        text: errorMessage(cause, detailMessage("saveFailed")),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h3 className="settings-subhead">{t("capabilities")}</h3>
      <div className="settings-group">
        {state ? (
          <>
            <SwitchRow
              title={t("autoCompact")}
              hint={t("autoCompactHint")}
              checked={state.autoCompact}
              disabled={busy}
              onChange={(autoCompact) => setState({ ...state, autoCompact })}
            />
            <SwitchRow
              title={t("subagents")}
              hint={t("subagentsHint")}
              checked={state.subagents}
              disabled={busy}
              onChange={(subagents) => setState({ ...state, subagents })}
            />
            <SwitchRow
              title="DeepSeek Search / Fetch"
              hint={t("webHint")}
              checked={state.web}
              disabled={busy}
              onChange={(web) => setState({ ...state, web })}
            />
            <form
              className="settings-row settings-row-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="settings-row-copy">
                <strong>{t("webKeyBudget")}</strong>
                <span>
                  <span
                    className={`settings-state ${state.hasWebKey ? "authenticated" : ""}`}
                  >
                    {state.hasWebKey
                      ? t("webKeyConfigured")
                      : t("webKeyMissing")}
                  </span>
                  {" · "}
                  {t("reservedRequests", { count: state.usedRequests })}
                </span>
              </div>
              <div className="settings-form-grid">
                <label className="wide">
                  <span>DeepSeek Web API Key</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={key}
                    disabled={clearKey}
                    placeholder={
                      state.hasWebKey ? t("replaceKey") : t("pasteWebKey")
                    }
                    onChange={(event) => setKey(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("requestBudget")}</span>
                  <input
                    type="number"
                    min="0"
                    max="100000"
                    value={state.maxRequests}
                    onChange={(event) =>
                      setState({
                        ...state,
                        maxRequests: Number(event.target.value),
                      })
                    }
                  />
                </label>
                {state.hasWebKey ? (
                  <label className="settings-check-field">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(event) => setClearKey(event.target.checked)}
                    />
                    <span>{t("deleteWebKey")}</span>
                  </label>
                ) : null}
                {state.unknownRequests > 0 ? (
                  <label className="settings-check-field wide">
                    <input
                      type="checkbox"
                      checked={acknowledgeUnknown}
                      onChange={(event) =>
                        setAcknowledgeUnknown(event.target.checked)
                      }
                    />
                    <span>
                      {t("acknowledgeUnknown", {
                        count: state.unknownRequests,
                      })}
                    </span>
                  </label>
                ) : null}
              </div>
              <p className="settings-feedback info">{t("requestBudgetHint")}</p>
              <div className="settings-actions">
                <button type="submit" className="tool-button" disabled={busy}>
                  <Save size={14} />
                  {busy ? t("saving") : t("saveCapabilities")}
                </button>
              </div>
              {feedback ? (
                <p
                  className={`settings-feedback ${feedback.tone}`}
                  aria-live="polite"
                >
                  {messageText(feedback.text, i18n)}
                </p>
              ) : null}
            </form>
          </>
        ) : (
          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>{t("readCapabilities")}</strong>
              <span>
                {feedback
                  ? messageText(feedback.text, i18n)
                  : t("readingConfig")}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
