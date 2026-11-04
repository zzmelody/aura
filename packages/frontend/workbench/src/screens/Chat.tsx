import React, { useEffect, useRef, useState } from "react";
import { VoiceInput } from "../features/coding/VoiceInput.tsx";
import { useIntegrations } from "../integrations.tsx";
import {
  ArrowUp,
  Check,
  Copy,
  FileCode2,
  RotateCcw,
  Square,
} from "lucide-react";
import { AuraMark } from "@aura/ui/components";
import type { Message, Workspace } from "@aura/core/types";
import type { WorkspaceController } from "../useWorkspace";
import { writeClipboard } from "../clipboard";
import { extractFlowCode } from "../flowDraft";
import { chatImageUrl } from "../chatImages";
import { ImageThumbnails } from "../ImageLightbox";
import { WorkflowRichText } from "./WorkflowValue";
import "./chat.css";
function MessageView({
  message,
  endpoint,
  retry,
  onApplyFlow,
}: {
  message: Message;
  endpoint: string;
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
      {user && message.images?.length ? (
        <ImageThumbnails
          className="message-images"
          lazy
          images={message.images.map((image) => ({
            key: image.assetId,
            src: chatImageUrl(endpoint, image.assetId),
            name: image.name ?? "附图",
          }))}
        />
      ) : null}
      {message.text || !user ? (
        <div
          className={`message-body${message.status === "error" ? " error" : ""}`}
        >
          {message.text ? (
            // Replies render as Markdown; user turns stay literal text.
            user || message.status === "error" ? (
              message.text
            ) : (
              <WorkflowRichText text={message.text} />
            )
          ) : message.status === "streaming" ? (
            <span className="thinking">
              <span className="aura-spinner" />
              正在准备回复…
            </span>
          ) : null}
          {message.status === "stopped" ? (
            <span className="message-stopped">回复已停止</span>
          ) : null}
        </div>
      ) : null}
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
              {applied ? "已放入编辑器" : "放入 工作流编辑器"}
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

/** Local demo and legacy records only; online conversations use ConversationPane. */
export function ChatScreen({
  workspace,
  connecting = false,
  context,
  onApplyFlow,
}: {
  workspace: WorkspaceController;
  connecting?: boolean;
  context?: string;
  onApplyFlow?(code: string): void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const { flags } = useIntegrations();
  const session = workspace.active;
  const messages = session?.messages;
  const running = workspace.busy;
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages]);
  const send = () => {
    if (connecting) return;
    void workspace.send(workspace.draft, false, context);
  };
  return (
    <section className="chat-screen" aria-label="本地演示对话">
      <div className="chat-transcript" ref={scroll}>
        {!messages?.length ? (
          <div className="chat-empty chat-home">
            <h2>从一个想法开始</h2>
          </div>
        ) : (
          messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              endpoint={workspace.workflows.endpoint}
              retry={connecting ? undefined : () => workspace.retry(context)}
              onApplyFlow={onApplyFlow}
            />
          ))
        )}
      </div>
      {session?.archivedAt ? (
        <p className="composer-footnote">这段对话已归档。</p>
      ) : (
        <div className="chat-composer-area">
          <div className="chat-composer">
            <textarea
              ref={editor}
              aria-label="消息输入框"
              placeholder="发送消息…"
              value={workspace.draft}
              maxLength={4000}
              disabled={connecting}
              onChange={(event) => workspace.setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (!running) send();
                }
              }}
            />
            <div className="composer-tools">
              <label className="provider-select">
                <select
                  aria-label="对话模式"
                  value={workspace.state.provider}
                  disabled={running}
                  onChange={(event) =>
                    workspace.setState((current) => ({
                      ...current,
                      provider: event.target.value as Workspace["provider"],
                    }))
                  }
                >
                  <option value="offline">本地演示</option>
                  <option value="codex">Codex 订阅</option>
                  <option value="lumina">Lumina</option>
                  <option value="custom">自定义 API</option>
                </select>
              </label>
              <span className="composer-spacer" />
              {flags?.voice && !connecting ? (
                <VoiceInput
                  key={session?.id ?? "draft"}
                  endpoint={workspace.workflows.endpoint}
                  onText={(text) => {
                    const draft = workspace.draft.trimEnd();
                    workspace.setDraft(
                      (draft ? `${draft} ${text}` : text).slice(0, 4000),
                    );
                    editor.current?.focus();
                  }}
                />
              ) : null}
              <button
                className="send-button"
                aria-label={running ? "停止生成" : "发送消息"}
                disabled={!running && (connecting || !workspace.draft.trim())}
                onClick={running ? workspace.stop : send}
              >
                {running ? <Square size={14} /> : <ArrowUp size={18} />}
              </button>
            </div>
          </div>
          <p className="composer-footnote">演示模式 · 未调用真实 AI</p>
        </div>
      )}
    </section>
  );
}
