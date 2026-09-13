import React, {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Download,
  FileCode2,
  ArrowLeft,
  MoreHorizontal,
  Play,
  RefreshCw,
  Sparkles,
  Undo2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { FlowGraphView } from "./FlowGraphView";
import type { FlowCatalogController } from "../flowCatalog";
import type { FlowCatalogEntry } from "@aura/protocol/types";
import { useFlowSource } from "../flowSource";
import { buildFlowGraph } from "../flowGraph";
import type { FlowDraftController } from "../flowDraft";

export function FlowStudio({
  endpoint,
  draft,
  editorRevision,
  onAsk,
  flowId,
  catalogState,
  onBack,
  onRun,
  initialLine,
}: {
  endpoint: string;
  draft: FlowDraftController;
  editorRevision: number;
  onAsk(): void;
  flowId: string;
  catalogState: FlowCatalogController;
  onBack(): void;
  onRun(flow: FlowCatalogEntry): void;
  initialLine?: number;
}) {
  const [view, setView] = useState<"graph" | "code">("graph");
  const [localDraft, setLocalDraft] = useState(flowId === "");
  const [notice, setNotice] = useState("");
  const [line, setLine] = useState(1);
  const isDraft = localDraft;
  const selectedFlow = isDraft
    ? undefined
    : catalogState.catalog?.flows.find((flow) => flow.id === flowId);
  const source = useFlowSource(
    endpoint,
    selectedFlow?.available ? flowId : "",
    selectedFlow?.sourceHash,
  );
  const code = isDraft ? draft.code : (source.source?.code ?? "");
  const deferredDraft = useDeferredValue(draft.code);
  const draftGraph = useMemo(
    () => buildFlowGraph(deferredDraft),
    [deferredDraft],
  );
  const title = isDraft
    ? draftGraph.title
    : (selectedFlow?.title ?? "工作流已移除");
  const description = isDraft
    ? "本地草稿 · 自动保存"
    : selectedFlow?.description;
  const file = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const codeInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editorRevision) {
      setLocalDraft(true);
      setView("graph");
    }
  }, [editorRevision]);
  useEffect(() => {
    if (initialLine !== undefined && code) openCode(initialLine);
  }, [initialLine, Boolean(code)]);
  function selectFlow(_id: string) {
    setLocalDraft(true);
    setView("graph");
    setNotice("");
    if (menu.current) menu.current.open = false;
  }
  function openCode(targetLine = 1) {
    setView("code");
    requestAnimationFrame(() => {
      const editor = codeInput.current;
      if (!editor) return;
      const lines = code.split("\n");
      const safeLine = Math.max(1, Math.min(targetLine, lines.length));
      const start = lines
        .slice(0, safeLine - 1)
        .reduce((offset, value) => offset + value.length + 1, 0);
      editor.focus();
      editor.setSelectionRange(
        start,
        start + (lines[safeLine - 1]?.length ?? 0),
      );
      editor.scrollTop = Math.max(0, (safeLine - 3) * 23);
      setLine(safeLine);
    });
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/javascript;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${isDraft ? "my-flow" : flowId}.flow.js`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (menu.current) menu.current.open = false;
  }

  return (
    <section className="workflow-editor" aria-label="工作流详情">
      <div className="flow-content">
        <header className="flow-content-heading">
          <button
            className="icon-control"
            aria-label="返回工作流"
            title="返回工作流"
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flow-content-title">
            <h1 title={title}>{title}</h1>
            <p title={description}>{description}</p>
          </div>
          <div className="flow-content-actions">
            {isDraft ? (
              <button
                className="tool-button accent"
                onClick={() => {
                  if (!isDraft && code) {
                    draft.update(code);
                    setLocalDraft(true);
                  }
                  onAsk();
                }}
              >
                <Sparkles size={14} />
                <span>助手生成</span>
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={!selectedFlow?.available}
                onClick={() => selectedFlow && onRun(selectedFlow)}
              >
                <Play size={13} />
                运行
              </button>
            )}
            <details
              className="flow-more"
              ref={menu}
              onKeyDown={(event) => {
                if (event.key === "Escape" && menu.current) {
                  menu.current.open = false;
                  menu.current.querySelector("summary")?.focus();
                }
              }}
            >
              <summary aria-label="工作流更多操作">
                <MoreHorizontal size={18} />
              </summary>
              <div className="flow-more-menu">
                {isDraft ? (
                  <>
                    <button
                      disabled={!draft.canUndo}
                      onClick={() => {
                        draft.undo();
                        if (menu.current) menu.current.open = false;
                      }}
                    >
                      <Undo2 size={14} />
                      撤销草稿替换
                    </button>
                    <button
                      onClick={() => {
                        file.current?.click();
                        if (menu.current) menu.current.open = false;
                      }}
                    >
                      <Upload size={14} />
                      导入到草稿
                    </button>
                  </>
                ) : (
                  <button
                    disabled={!code}
                    onClick={() => {
                      draft.update(code);
                      selectFlow("");
                      setNotice("已复制到本地草稿，可编辑并导出。");
                    }}
                  >
                    <FileCode2 size={14} />
                    复制到草稿编辑
                  </button>
                )}
                <button disabled={!code.trim()} onClick={download}>
                  <Download size={14} />
                  导出代码
                </button>
              </div>
            </details>
          </div>
        </header>
        <div
          className="studio-tabs"
          role="tablist"
          aria-label="工作流视图"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            );
            const index = tabs.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                    tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          <button
            id="graph-tab"
            role="tab"
            aria-selected={view === "graph"}
            tabIndex={view === "graph" ? 0 : -1}
            aria-controls="graph-panel"
            onClick={() => setView("graph")}
          >
            <Workflow size={14} />
            流程图
          </button>
          <button
            id="code-tab"
            role="tab"
            aria-selected={view === "code"}
            tabIndex={view === "code" ? 0 : -1}
            aria-controls="code-panel"
            onClick={() => setView("code")}
          >
            <FileCode2 size={14} />
            代码
          </button>
          <span className="flow-view-status">
            {isDraft
              ? draft.saved
                ? "已保存"
                : "保存中…"
              : selectedFlow?.available
                ? "已注册"
                : "不可用"}
          </span>
        </div>
        <input
          type="file"
          hidden
          ref={file}
          accept=".js,.ts,.txt"
          aria-label="选择 工作流文件"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (selected.size > 100_000) {
              setNotice("请选择小于 100 KB 的 工作流文件。");
              return;
            }
            try {
              draft.update(await selected.text());
              selectFlow("");
              setNotice(`已导入 ${selected.name}。`);
            } catch {
              setNotice("文件读取失败，请重试。");
            }
          }}
        />
        {notice || (isDraft && draft.saveError) || selectedFlow?.error ? (
          <div
            className="editor-notice"
            role={draft.saveError || selectedFlow?.error ? "alert" : "status"}
          >
            <span>
              {(isDraft && draft.saveError) || selectedFlow?.error || notice}
            </span>
            {notice ? (
              <button
                className="icon-control"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
        {!isDraft && !source.source ? (
          <div
            className="flow-preview-empty"
            role={source.error ? "alert" : "status"}
          >
            <Workflow size={28} strokeWidth={1.3} />
            <strong>
              {!selectedFlow
                ? "这个 Flow 已从目录移除"
                : !selectedFlow.available
                  ? "Flow 暂不可用"
                  : source.error
                    ? "无法加载流程预览"
                    : "正在加载流程图…"}
            </strong>
            <p>{source.error || selectedFlow?.error}</p>
            {source.error && selectedFlow?.available ? (
              <button className="tool-button" onClick={source.refresh}>
                <RefreshCw size={13} />
                重试预览
              </button>
            ) : null}
          </div>
        ) : null}
        {view === "graph" && (isDraft || source.source) ? (
          <FlowGraphView key={flowId} code={code} onOpenCode={openCode} />
        ) : null}
        <div
          id="code-panel"
          role="tabpanel"
          aria-labelledby="code-tab"
          className="editor-panel"
          hidden={view !== "code" || (!isDraft && !source.source)}
        >
          <div className="code-editor">
            <div className="code-gutter" ref={gutter} aria-hidden="true">
              {code.split("\n").map((_, index) => (
                <div key={index}>{index + 1}</div>
              ))}
            </div>
            <textarea
              ref={codeInput}
              className="flow-code"
              aria-label={isDraft ? "工作流代码编辑器" : "工作流代码预览"}
              readOnly={!isDraft}
              spellCheck={false}
              value={code}
              onChange={(event) => draft.edit(event.target.value)}
              onScroll={(event) => {
                if (gutter.current)
                  gutter.current.scrollTop = event.currentTarget.scrollTop;
              }}
              onSelect={(event) =>
                setLine(
                  event.currentTarget.value
                    .slice(0, event.currentTarget.selectionStart)
                    .split("\n").length,
                )
              }
              onKeyDown={(event) => {
                if (!isDraft || event.key !== "Tab" || event.shiftKey) return;
                event.preventDefault();
                const element = event.currentTarget;
                const start = element.selectionStart;
                const end = element.selectionEnd;
                draft.edit(`${code.slice(0, start)}  ${code.slice(end)}`);
                requestAnimationFrame(() => {
                  element.selectionStart = element.selectionEnd = start + 2;
                });
              }}
            />
          </div>
          <div className="editor-status">
            <span>
              <Check size={12} />
              {isDraft ? "本地草稿 · Tab 缩进" : "已注册版本 · 只读"}
            </span>
            <span>Ln {line} · JavaScript</span>
          </div>
        </div>
        {isDraft && view === "graph" ? (
          <div className="flow-draft-hint">
            草稿可编辑和导出，注册后即可运行。
          </div>
        ) : null}
      </div>
    </section>
  );
}
