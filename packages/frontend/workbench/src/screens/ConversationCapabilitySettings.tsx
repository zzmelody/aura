import React, { useEffect, useState } from "react";
import type { CodingCapabilities } from "@aura/protocol/types";
import {
  readCodingCapabilities,
  saveCodingCapabilities,
} from "../features/coding/api.ts";

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
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    let current = true;
    void readCodingCapabilities(endpoint)
      .then((value) => {
        if (current) setState(value);
      })
      .catch(() => {
        if (current) setFeedback("无法读取对话能力设置。");
      });
    return () => {
      current = false;
    };
  }, [endpoint]);
  async function save() {
    if (!state) return;
    setBusy(true);
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
      setFeedback("已保存，下次发送消息时使用新设置。");
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="model-service-card">
      <h3>对话能力</h3>
      <p>主对话和旁支可使用 DSH 的上下文压缩、DeepSeek Web 和只读子 Agent。</p>
      {state ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={state.autoCompact}
              onChange={(event) =>
                setState({ ...state, autoCompact: event.target.checked })
              }
            />
            自动压缩较早上下文
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.subagents}
              onChange={(event) =>
                setState({ ...state, subagents: event.target.checked })
              }
            />
            启用调研与审查子 Agent（最多 2 个）
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.web}
              onChange={(event) =>
                setState({ ...state, web: event.target.checked })
              }
            />
            启用 DeepSeek Search / Fetch
          </label>
          <label>
            DeepSeek Web API Key（{state.hasWebKey ? "已配置" : "未配置"}）
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
            删除保存的 Web Key
          </label>
          <p>
            仅访问 DeepSeek 官方 Search / Fetch
            API，不发送原始问题。密钥保存在后端。
          </p>
          <label>
            累计额外请求额度
            <input
              type="number"
              min="0"
              max="100000"
              value={state.maxRequests}
              onChange={(event) =>
                setState({ ...state, maxRequests: Number(event.target.value) })
              }
            />
          </label>
          <p>
            已预留 {state.usedRequests} 次。每次压缩摘要、子 Agent
            模型调用、Search 或 Fetch
            预留一次；这是次数上限，不是金额上限。失败或取消不退回次数。
          </p>
          {state.unknownRequests > 0 ? (
            <label>
              <input
                type="checkbox"
                checked={acknowledgeUnknown}
                onChange={(event) =>
                  setAcknowledgeUnknown(event.target.checked)
                }
              />
              我已核对 {state.unknownRequests}{" "}
              次未知结果，允许后续新请求（不会重发旧请求）
            </label>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存对话能力"}
          </button>
        </>
      ) : null}
      {feedback ? <p role="status">{feedback}</p> : null}
    </section>
  );
}
