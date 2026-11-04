import React, { useEffect, useState } from "react";
import { Save } from "lucide-react";
import type { CodingCapabilities } from "@aura/protocol/types";
import {
  readCodingCapabilities,
  saveCodingCapabilities,
} from "../features/coding/api.ts";

type Feedback = { tone: "ok" | "error" | "info"; text: string } | undefined;

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
          setFeedback({ tone: "error", text: "无法读取对话能力设置。" });
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
      setFeedback({ tone: "ok", text: "已保存，下次发送消息时使用新设置。" });
    } catch (cause) {
      setFeedback({
        tone: "error",
        text: cause instanceof Error ? cause.message : "保存失败。",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h3 className="settings-subhead">对话能力</h3>
      <div className="settings-group">
        {state ? (
          <>
            <SwitchRow
              title="自动压缩较早上下文"
              hint="上下文接近上限时由 DSH 摘要较早的轮次。"
              checked={state.autoCompact}
              disabled={busy}
              onChange={(autoCompact) => setState({ ...state, autoCompact })}
            />
            <SwitchRow
              title="调研与审查子 Agent"
              hint="只读子 Agent，最多同时 2 个。"
              checked={state.subagents}
              disabled={busy}
              onChange={(subagents) => setState({ ...state, subagents })}
            />
            <SwitchRow
              title="DeepSeek Search / Fetch"
              hint="仅访问 DeepSeek 官方 Search / Fetch API，不发送原始问题。"
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
                <strong>Web Key 与请求额度</strong>
                <span>
                  <span
                    className={`settings-state ${state.hasWebKey ? "authenticated" : ""}`}
                  >
                    {state.hasWebKey ? "已配置 Web Key" : "未配置 Web Key"}
                  </span>
                  {` · 已预留 ${state.usedRequests} 次`}
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
                      state.hasWebKey
                        ? "已保存，输入新 Key 可替换"
                        : "粘贴 DeepSeek Web API Key"
                    }
                    onChange={(event) => setKey(event.target.value)}
                  />
                </label>
                <label>
                  <span>累计额外请求额度</span>
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
                    <span>删除保存的 Web Key</span>
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
                      我已核对 {state.unknownRequests}{" "}
                      次未知结果，允许后续新请求（不会重发旧请求）
                    </span>
                  </label>
                ) : null}
              </div>
              <p className="settings-feedback info">
                每次压缩摘要、子 Agent 模型调用、Search 或 Fetch
                预留一次；这是次数上限，不是金额上限，失败或取消不退回。密钥只保存在后端。
              </p>
              <div className="settings-actions">
                <button type="submit" className="tool-button" disabled={busy}>
                  <Save size={14} />
                  {busy ? "保存中…" : "保存对话能力"}
                </button>
              </div>
              {feedback ? (
                <p
                  className={`settings-feedback ${feedback.tone}`}
                  aria-live="polite"
                >
                  {feedback.text}
                </p>
              ) : null}
            </form>
          </>
        ) : (
          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>读取对话能力</strong>
              <span>{feedback?.text ?? "正在读取后端配置…"}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
