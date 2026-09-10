import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  FileCode2,
  GitBranch,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { AuraMark } from "@aura/ui/components";
import { writeClipboard } from "../clipboard";
import { extractFlowCode } from "../flowDraft";
import type { WorkspaceController } from "../useWorkspace";
import type { Message } from "@aura/core/types";

function MessageView({
  message,
  retry,
  onApplyFlow,
}: {
  message: Message;
  retry?: () => void;
  onApplyFlow?: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (!copied && !applied) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setApplied(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, [copied, applied]);
  const user = message.role === "user";
  const flowCode =
    !user && message.status === "complete" && onApplyFlow
      ? extractFlowCode(message.text)
      : undefined;
  return (
    <article
      className={`chat-message ${user ? "from-user" : "from-assistant"}`}
    >
      {!user ? (
        <div className="message-author">
          <AuraMark size={20} />
          <strong>Aura</strong>
          {message.status === "streaming" ? (
            <span className="generating-label">生成中</span>
          ) : null}
        </div>
      ) : null}
      <div
        className={`message-body${message.status === "error" ? " error" : ""}`}
      >
        {message.text ||
          (message.status === "streaming" ? (
            <span className="thinking">
              <span className="aura-spinner" />
              正在准备回复…
            </span>
          ) : null)}
        {message.status === "stopped" ? (
          <span className="message-stopped">回复已停止</span>
        ) : null}
      </div>
      {!user && message.status !== "streaming" ? (
        <div className="message-actions">
          <button
            className="icon-control"
            aria-label={copied ? "已复制" : "复制回复"}
            onClick={() =>
              void writeClipboard(message.text)
                .then(() => {
                  setCopied(true);
                  setCopyError(false);
                })
                .catch(() => setCopyError(true))
            }
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {message.status === "error" && retry ? (
            <button className="tool-button" onClick={retry}>
              <RotateCcw size={13} />
              重试
            </button>
          ) : null}
          {flowCode ? (
            <button
              className="tool-button accent"
              onClick={() => {
                onApplyFlow?.(flowCode);
                setApplied(true);
              }}
            >
              <FileCode2 size={13} />
              {applied ? "已放入编辑器" : "放入 Flow 编辑器"}
            </button>
          ) : null}
          {copyError ? (
            <span role="status">复制失败，请选择文字复制。</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ChatScreen({
  workspace,
  flowMode = false,
  context,
  onApplyFlow,
}: {
  workspace: WorkspaceController;
  flowMode?: boolean;
  context?: string;
  onApplyFlow?: (code: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const draft = workspace.draft;
  const messages = workspace.active?.messages ?? [];
  const providerName =
    workspace.state.provider === "codex"
      ? "Codex"
      : workspace.state.provider === "offline"
        ? "本地演示"
        : "DSH 演示";
  useEffect(() => {
    nearBottom.current = true;
  }, [workspace.active?.id]);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  function submit() {
    if (!draft.trim() || workspace.busy) return;
    nearBottom.current = true;
    void workspace.send(draft, false, context);
  }
  return (
    <section
      className="chat-screen"
      aria-label={flowMode ? "Flow 生成对话" : "会话内容"}
    >
      <div className="chat-title">
        <strong title={workspace.active?.title}>
          {workspace.active?.title ?? (flowMode ? "一起构建 Flow" : "新的对话")}
        </strong>
        <span className="badge">
          <span
            className={`session-status${workspace.busy ? " running" : ""}`}
          />
          {workspace.busy ? "生成中" : providerName}
        </span>
      </div>
      <div
        className="chat-transcript"
        ref={scroll}
        onScroll={(event) => {
          const el = event.currentTarget;
          nearBottom.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 100;
        }}
      >
        {!messages.length ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              {flowMode ? (
                <GitBranch size={24} strokeWidth={1.4} />
              ) : (
                <Sparkles size={24} strokeWidth={1.4} />
              )}
            </div>
            <h2>{flowMode ? "想把什么变成 Flow？" : "从一个想法开始"}</h2>
            <p>
              {flowMode
                ? "描述任务，拆分步骤，再把生成的代码放入编辑器。"
                : "提一个问题，或继续你的下一步。"}
            </p>
            <div className="chat-suggestions">
              {(flowMode
                ? [
                    "生成一个并行分析、汇总报告的 Flow",
                    "检查当前 Flow 的输入输出",
                    "为当前 Flow 增加风险审阅步骤",
                  ]
                : ["帮我梳理一个新想法", "帮我安排今天的计划", "你好，Aura"]
              ).map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    workspace.setDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  <span>{prompt}</span>
                  <ArrowUp size={13} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              retry={
                message.id === messages.at(-1)?.id
                  ? () => workspace.retry(context)
                  : undefined
              }
              onApplyFlow={flowMode ? onApplyFlow : undefined}
            />
          ))
        )}
      </div>
      <div className="chat-composer-area">
        {flowMode ? (
          <div className="composer-context">
            <FileCode2 size={12} />
            <span>当前 Flow 草稿作为上下文</span>
          </div>
        ) : null}
        <div className="chat-composer">
          <textarea
            ref={input}
            aria-label="消息输入框"
            placeholder={flowMode ? "描述要生成或修改的 Flow…" : "发送消息…"}
            maxLength={4000}
            value={draft}
            onChange={(event) => workspace.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-tools">
            <label className="provider-select">
              <select
                aria-label="对话模型"
                value={workspace.state.provider}
                disabled={workspace.busy}
                onChange={(event) =>
                  workspace.setState((s) => ({
                    ...s,
                    provider: event.target.value as typeof s.provider,
                    endpoint: s.endpoint || "http://127.0.0.1:4311",
                  }))
                }
              >
                <option value="offline">本地演示</option>
                <option value="dsh">DSH 演示</option>
                <option value="codex">Codex 订阅</option>
              </select>
            </label>
            <span className="composer-count">
              {draft.length > 3600 ? `${draft.length}/4000` : ""}
            </span>
            <button
              className="send-button"
              aria-label={workspace.busy ? "停止生成" : "发送消息"}
              disabled={!workspace.busy && !draft.trim()}
              onClick={workspace.busy ? workspace.stop : submit}
            >
              {workspace.busy ? (
                <Square size={14} fill="currentColor" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </div>
        </div>
        <div className="composer-footnote">
          <span>
            {workspace.state.provider === "codex"
              ? "Codex 订阅"
              : "演示模式 · 未调用真实 AI"}
          </span>
          <span>Enter 发送 · ⇧ Enter 换行</span>
        </div>
        <span className="sr-only" aria-live="polite">
          {workspace.busy
            ? "正在生成回复"
            : messages.at(-1)?.role === "assistant"
              ? "回复结束"
              : ""}
        </span>
      </div>
    </section>
  );
}
