import { providerMode } from "@aura/core";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Clapperboard,
  Copy,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Newspaper,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { FlowCatalogEntry, FlowMode } from "@aura/protocol/types";
import { AuraMark } from "@aura/ui/components";
import { writeClipboard } from "../clipboard";
import { extractFlowCode } from "../flowDraft";
import { filterFlows, prefillFlowInput, slashQuery } from "../flowPicker";
import type { WorkspaceController } from "../useWorkspace";
import type { ChatImage, Message } from "@aura/core/types";
import {
  CHAT_IMAGE_LIMIT,
  chatImageType,
  chatImageUrl,
  uploadChatImage,
} from "../chatImages";
import type { StudioTab } from "../types";
import { workflowRunKey } from "../workflowSessions";
import { workflowExecutions } from "../workflowPresentation";
import { FlowPicker, handlePickerKey } from "./FlowPicker";
import { schemaInitialValue } from "./WorkflowInput";
import { WorkflowRunForm } from "./WorkflowRunForm";
import { WorkflowRunResult } from "./WorkflowRun";
import { ChatModelControls } from "./ChatModelControls";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { WorkflowRichText } from "./WorkflowValue";
import "./chat.css";

const emptyMessages: Message[] = [];

type Attachment = {
  key: string;
  preview: string;
  name: string;
  image?: ChatImage;
  error?: string;
};

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
        <div className="message-images">
          {message.images.map((image) => (
            <a
              key={image.assetId}
              href={chatImageUrl(endpoint, image.assetId)}
              target="_blank"
              rel="noreferrer"
              title={image.name}
            >
              <img
                src={chatImageUrl(endpoint, image.assetId)}
                alt={image.name ?? "附图"}
                loading="lazy"
              />
            </a>
          ))}
        </div>
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

export function ChatScreen({
  workspace,
  flowMode = false,
  context,
  onApplyFlow,
  flows = [],
  flowsLoading = false,
  onOpenStudio,
}: {
  workspace: WorkspaceController;
  flowMode?: boolean;
  context?: string;
  onApplyFlow?: (code: string) => void;
  /** Catalog used by the composer's workflow picker; omitted in flow mode. */
  flows?: FlowCatalogEntry[];
  flowsLoading?: boolean;
  onOpenStudio?: (studio: StudioTab) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const formId = useId();
  const draft = workspace.draft;
  const session = workspace.active;
  const messages = session?.messages ?? emptyMessages;
  const canInvoke = !flowMode;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerActive, setPickerActive] = useState(0);
  const [selected, setSelected] = useState<FlowCatalogEntry>();
  const [formText, setFormText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());
  const endpoint = workspace.workflows.endpoint;
  const canAttach = !flowMode && workspace.state.provider !== "offline";
  const uploading = attachments.some((item) => !item.image && !item.error);
  const ready = attachments.flatMap((item) => (item.image ? [item.image] : []));
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  /**
   * Images from the clipboard: screenshots and copied browser images often
   * arrive only as clipboard items, with an empty `files` list.
   */
  function pastedImages(data: DataTransfer) {
    const files = Array.from(data.files);
    if (!files.length)
      for (const item of Array.from(data.items))
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
    return files
      .filter((file) => chatImageType(file))
      .map((file, index) =>
        // Clipboard images are usually all named "image.png"; keep them apart.
        file.name && file.name !== "image.png"
          ? file
          : new File(
              [file],
              `粘贴的图片-${Date.now()}-${index + 1}.${(chatImageType(file) ?? "image/png").split("/")[1]}`,
              {
                type: chatImageType(file) ?? file.type,
              },
            ),
      );
  }
  function paste(event: React.ClipboardEvent) {
    const files = pastedImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    if (flowMode) return;
    if (!canAttach) {
      setAttachError(
        "本地演示模式不能附带图片，请在下方切换到 DSH 演示或 Codex 订阅。",
      );
      return;
    }
    attach(files);
  }
  function attach(files: FileList | File[]) {
    setAttachError("");
    const accepted = Array.from(files).filter((file) => chatImageType(file));
    if (!accepted.length) {
      setAttachError("只支持 PNG、JPEG 或 WebP 图片。");
      return;
    }
    const room = CHAT_IMAGE_LIMIT - attachments.length;
    if (accepted.length > room)
      setAttachError(`一条消息最多附带 ${CHAT_IMAGE_LIMIT} 张图片。`);
    for (const file of accepted.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setAttachments((current) => [
        ...current,
        { key, preview, name: file.name || "image" },
      ]);
      uploadChatImage(endpoint, file)
        .then((image) =>
          setAttachments((current) =>
            current.map((item) =>
              item.key === key ? { ...item, image } : item,
            ),
          ),
        )
        .catch((cause: unknown) =>
          setAttachments((current) =>
            current.map((item) =>
              item.key === key
                ? {
                    ...item,
                    error: cause instanceof Error ? cause.message : "上传失败",
                  }
                : item,
            ),
          ),
        );
    }
  }
  function release(preview: string) {
    URL.revokeObjectURL(preview);
    previews.current.delete(preview);
  }
  function detach(key: string) {
    setAttachments((current) => {
      const item = current.find((value) => value.key === key);
      if (item) release(item.preview);
      return current.filter((value) => value.key !== key);
    });
  }
  function clearAttachments() {
    // Sent bubbles render from the server copy, so local previews can go.
    for (const item of attachments) release(item.preview);
    setAttachments([]);
    setAttachError("");
  }
  const slash = canInvoke && !selected ? slashQuery(draft) : undefined;
  const pickerVisible = canInvoke && (pickerOpen || slash !== undefined);
  const query = slash ?? pickerQuery;
  const matches = filterFlows(flows, query);
  const streaming = messages.some(
    (message) => message.status === "streaming" && !message.workflowRunId,
  );
  const pendingRun = session?.pendingWorkflow;
  const submitting = session
    ? workspace.workflows.submitting.includes(session.id)
    : false;
  const runError = session ? workspace.workflows.errors[session.id] : "";
  const providerName = {
    offline: "本地演示",
    dsh: "DSH 演示",
    codex: "Codex",
    lumina: "Lumina",
    custom: "自定义 API",
  }[workspace.state.provider];
  const defaultMode: FlowMode = providerMode(workspace.state.provider);
  const realModel = defaultMode !== "demo";
  useEffect(() => {
    nearBottom.current = true;
    setSelected(undefined);
    setPickerOpen(false);
  }, [session?.id]);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, selected]);
  useEffect(() => setPickerActive(0), [query]);
  function closePicker() {
    setPickerOpen(false);
    setPickerQuery("");
    if (slash !== undefined) workspace.setDraft("");
    input.current?.focus();
  }
  function pick(flow: FlowCatalogEntry) {
    const prompt = slash !== undefined ? "" : draft;
    setSelected(flow);
    setFormText(
      JSON.stringify(
        prefillFlowInput(
          schemaInitialValue(flow.inputSchema),
          flow.inputSchema,
          prompt,
        ),
        null,
        2,
      ),
    );
    setPickerOpen(false);
    setPickerQuery("");
    workspace.setDraft("");
    nearBottom.current = true;
  }
  function submit() {
    if (
      (!draft.trim() && !ready.length) ||
      streaming ||
      uploading ||
      slash !== undefined
    )
      return;
    nearBottom.current = true;
    void workspace.send(draft, false, context, ready);
    clearAttachments();
  }
  async function runSelected(
    value: Parameters<typeof workspace.startChatWorkflow>[1],
    mode: FlowMode,
  ) {
    if (!selected) return;
    nearBottom.current = true;
    const accepted = await workspace.startChatWorkflow(selected, value, mode);
    if (accepted) setSelected(undefined);
  }
  const executions = workflowExecutions(messages);
  let executionIndex = 0;
  const quickFlows = flows.filter((flow) => flow.available).slice(0, 2);
  return (
    <section
      className="chat-screen"
      aria-label={flowMode ? "工作流生成对话" : "会话内容"}
    >
      <div className="chat-title">
        <strong title={session?.title}>
          {session?.title ?? (flowMode ? "一起构建工作流" : "新的对话")}
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
        {!messages.length && !selected && !pendingRun ? (
          <div className={`chat-empty${flowMode ? "" : " chat-home"}`}>
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
                : "直接提问，或输入 / 调用一个工作流。"}
            </p>
            {flowMode ? (
              <div className="chat-suggestions">
                {[
                  "生成一个并行分析、汇总报告的 Flow",
                  "检查当前 Flow 的输入输出",
                  "为当前 Flow 增加风险审阅步骤",
                ].map((prompt) => (
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
            ) : (
              <div className="chat-quick">
                {quickFlows.map((flow) => (
                  <button key={flow.id} onClick={() => pick(flow)}>
                    <small>工作流</small>
                    <span>{flow.title}</span>
                  </button>
                ))}
                {onOpenStudio ? (
                  <>
                    <button onClick={() => onOpenStudio("studio:content")}>
                      <small>工作台</small>
                      <span>
                        <Newspaper size={14} />
                        自媒体内容
                      </span>
                    </button>
                    <button onClick={() => onOpenStudio("studio:video")}>
                      <small>工作台</small>
                      <span>
                        <Clapperboard size={14} />
                        视频项目
                      </span>
                    </button>
                  </>
                ) : null}
                <button
                  onClick={() => {
                    workspace.setDraft("帮我梳理一个新想法");
                    input.current?.focus();
                  }}
                >
                  <small>对话</small>
                  <span>帮我梳理一个新想法</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          executions.map(({ message, input: runInput }) => {
            const ref = message.workflow ?? session?.workflow;
            if (message.workflowRunId && ref)
              return (
                <WorkflowRunResult
                  key={message.id}
                  endpoint={ref.endpoint}
                  message={message}
                  input={runInput}
                  index={++executionIndex}
                  title={ref.title}
                  inputSchema={
                    flows.find((flow) => flow.id === ref.id)?.inputSchema
                  }
                  cached={
                    workspace.workflows.runs[
                      workflowRunKey(ref.endpoint, message.workflowRunId)
                    ]
                  }
                  receive={workspace.workflows.receive}
                  onCancel={() => void workspace.workflows.cancel(session!.id)}
                />
              );
            return (
              <MessageView
                key={message.id}
                message={message}
                endpoint={endpoint}
                retry={
                  message.id === messages.at(-1)?.id
                    ? () => workspace.retry(context)
                    : undefined
                }
                onApplyFlow={flowMode ? onApplyFlow : undefined}
              />
            );
          })
        )}
        {pendingRun ? (
          <article className="chat-pending-run" aria-label="待确认的工作流">
            <GitBranch size={16} />
            <div>
              <strong>
                {submitting
                  ? `正在提交 ${pendingRun.title}`
                  : `${pendingRun.title} 待确认`}
              </strong>
              <p>
                {submitting
                  ? "正在创建本次执行记录…"
                  : "服务尚未确认提交结果。重试会继续同一次执行。"}
              </p>
              {runError ? (
                <p role="alert" className="error">
                  {runError}
                </p>
              ) : null}
            </div>
            {!submitting ? (
              <div className="chat-pending-actions">
                <button
                  className="tool-button"
                  onClick={() =>
                    void workspace.workflows.start(
                      session!.id,
                      pendingRun.pending.input,
                      pendingRun.pending.mode,
                    )
                  }
                >
                  重试提交
                </button>
                <button
                  className="text-control"
                  onClick={() =>
                    workspace.workflows.discardPending(session!.id)
                  }
                >
                  放弃
                </button>
              </div>
            ) : null}
          </article>
        ) : runError && !selected ? (
          <p className="workflow-session-error error" role="alert">
            {runError}
          </p>
        ) : null}
        {selected ? (
          <div className="chat-run-form">
            <WorkflowRunForm
              id={formId}
              title={`运行 ${selected.title}`}
              subtitle={selected.description || selected.id}
              schema={selected.inputSchema}
              text={formText}
              onTextChange={setFormText}
              endpoint={workspace.workflows.endpoint}
              initialMode={defaultMode}
              locked={
                submitting ||
                Boolean(pendingRun) ||
                workspace.workflows.hasOpenRun(session?.id)
              }
              submitting={submitting}
              unavailable={!selected.available}
              error={runError}
              notice={
                workspace.workflows.hasOpenRun(session?.id) ? (
                  <div className="workflow-pending" role="status">
                    这条对话里还有工作流在运行，结束后可再次提交。
                  </div>
                ) : null
              }
              onSubmit={(value, mode) => void runSelected(value, mode)}
              onClose={() => {
                setSelected(undefined);
                input.current?.focus();
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="chat-composer-area">
        {flowMode ? (
          <div className="composer-context">
            <FileCode2 size={12} />
            <span>当前 Flow 草稿作为上下文</span>
          </div>
        ) : null}
        {selected ? (
          <div className="composer-flow-chip">
            <span>
              <GitBranch size={13} />
              {selected.title}
            </span>
            <button
              className="icon-control"
              aria-label="取消调用工作流"
              onClick={() => setSelected(undefined)}
            >
              <X size={13} />
            </button>
          </div>
        ) : null}
        <div
          className={`chat-composer${dragging ? " dragging" : ""}`}
          onPaste={paste}
          onDragOver={(event) => {
            if (!canAttach || !event.dataTransfer.types.includes("Files"))
              return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (!canAttach) return;
            event.preventDefault();
            setDragging(false);
            attach(event.dataTransfer.files);
          }}
        >
          {attachments.length ? (
            <div className="composer-attachments" aria-label="已附加的图片">
              {attachments.map((item) => (
                <figure
                  key={item.key}
                  className={`composer-attachment${item.error ? " failed" : ""}`}
                  title={item.error ?? item.name}
                >
                  <img src={item.preview} alt={item.name} />
                  {!item.image && !item.error ? (
                    <span className="composer-attachment-state" role="status">
                      <LoaderCircle size={16} className="workflow-spinner" />
                      <span className="sr-only">正在上传 {item.name}</span>
                    </span>
                  ) : null}
                  {item.error ? (
                    <span className="composer-attachment-state" role="alert">
                      !<span className="sr-only">{item.error}</span>
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`移除图片 ${item.name}`}
                    onClick={() => detach(item.key)}
                  >
                    <X size={12} />
                  </button>
                </figure>
              ))}
            </div>
          ) : null}
          {dragging ? (
            <div className="composer-drop-hint" aria-hidden="true">
              松开以添加图片
            </div>
          ) : null}
          {pickerVisible ? (
            <FlowPicker
              flows={matches}
              query={query}
              active={pickerActive}
              loading={flowsLoading}
              searchable={slash === undefined}
              onQuery={setPickerQuery}
              onActive={setPickerActive}
              onPick={pick}
              onClose={closePicker}
            />
          ) : null}
          <textarea
            ref={input}
            aria-label="消息输入框"
            placeholder={
              flowMode
                ? "描述要生成或修改的 Flow…"
                : "发送消息，或输入 / 调用工作流…"
            }
            maxLength={4000}
            value={draft}
            onChange={(event) => workspace.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                slash !== undefined &&
                handlePickerKey(
                  event,
                  matches,
                  pickerActive,
                  setPickerActive,
                  pick,
                  closePicker,
                )
              )
                return;
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
            <ComposerAddMenu
              canAttach={canAttach}
              attachFull={attachments.length >= CHAT_IMAGE_LIMIT}
              canInvoke={canInvoke}
              pickerOpen={pickerVisible}
              onAttach={() => fileInput.current?.click()}
              onWorkflow={() => setPickerOpen(true)}
            />
            {canAttach ? (
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) attach(event.target.files);
                  event.target.value = "";
                }}
              />
            ) : null}
            <label className="provider-select">
              <select
                aria-label="对话模式"
                value={workspace.state.provider}
                disabled={streaming}
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
                <option value="lumina">Lumina</option>
                <option value="custom">自定义 API</option>
              </select>
            </label>
            <span className="composer-spacer" />
            {workspace.ready && workspace.state.provider !== "offline" ? (
              <ChatModelControls
                endpoint={endpoint}
                mode={defaultMode}
                selection={workspace.chatModelConfig[defaultMode] ?? {}}
                disabled={streaming}
                onChange={(selection) =>
                  workspace.setChatModelConfig(defaultMode, selection)
                }
              />
            ) : null}
            <span className="composer-count">
              {draft.length > 3600 ? `${draft.length}/4000` : ""}
            </span>
            <button
              className="send-button"
              aria-label={streaming ? "停止生成" : "发送消息"}
              disabled={
                !streaming &&
                ((!draft.trim() && !ready.length) ||
                  uploading ||
                  slash !== undefined)
              }
              onClick={streaming ? workspace.stop : submit}
            >
              {streaming ? (
                <Square size={14} fill="currentColor" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </div>
        </div>
        {attachError ? (
          <p className="composer-attach-error" role="alert">
            {attachError}
          </p>
        ) : null}
        {!realModel ? (
          <p className="composer-footnote">
            {attachments.length && workspace.state.provider === "dsh"
              ? "演示模式 · 图片不会被模型查看"
              : "演示模式 · 未调用真实 AI"}
          </p>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {streaming
            ? "正在生成回复"
            : messages.at(-1)?.role === "assistant"
              ? "回复结束"
              : ""}
        </span>
      </div>
    </section>
  );
}
