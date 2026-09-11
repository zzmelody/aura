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
  GitBranch,
  List,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Undo2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { FlowsScreen } from "./Flows";
import { FlowGraphView } from "./FlowGraphView";
import { useFlowCatalog } from "../flowCatalog";
import { useFlowSource } from "../flowSource";
import { buildFlowGraph } from "../flowGraph";
import type { FlowDraftController } from "../flowDraft";

export function FlowStudio({
  endpoint,
  draft,
  editorRevision,
  onAsk,
}: {
  endpoint: string;
  draft: FlowDraftController;
  editorRevision: number;
  onAsk(): void;
}) {
  const [view, setView] = useState<"graph" | "code" | "runs">("graph");
  // null selects the first registered Flow when the catalog arrives; "" is the draft.
  const [selection, setSelection] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [line, setLine] = useState(1);
  const flowCatalog = useFlowCatalog(endpoint);
  const flows = flowCatalog.catalog?.flows ?? [];
  const flowId =
    selection === null
      ? (flows.find((flow) => flow.available)?.id ?? flows[0]?.id ?? "")
      : selection;
  const selectedFlow = flows.find((flow) => flow.id === flowId);
  const isDraft = flowId === "";
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
    : (selectedFlow?.title ?? "Flow 已移除");
  const description = isDraft
    ? "本地草稿 · 自动保存"
    : selectedFlow?.description;
  const filtered = flows.filter(
    (flow) =>
      (!onlyAvailable || flow.available) &&
      `${flow.title} ${flow.id} ${flow.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const file = useRef<HTMLInputElement>(null);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const codeInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editorRevision) return;
    setSelection("");
    setView("graph");
    setLibraryOpen(false);
    setNotice("已应用助手生成的代码。");
  }, [editorRevision]);
  useEffect(() => {
    setSelection(null);
    setView("graph");
  }, [endpoint]);
  useEffect(() => {
    if (!libraryOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLibraryOpen(false);
      requestAnimationFrame(() => libraryToggle.current?.focus());
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [libraryOpen]);

  function selectFlow(id: string) {
    setSelection(id);
    setView("graph");
    setLibraryOpen(false);
    setNotice("");
    if (menu.current) menu.current.open = false;
    if (libraryOpen)
      requestAnimationFrame(() => libraryToggle.current?.focus());
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
    <section
      className={`flow-studio${libraryOpen ? " library-open" : ""}`}
      aria-label="Flow 编辑与运行"
    >
      <aside
        className="flow-library"
        aria-label="Flow 列表"
        onKeyDown={(event) => {
          if (event.key === "Escape" && libraryOpen) {
            setLibraryOpen(false);
            requestAnimationFrame(() => libraryToggle.current?.focus());
          }
        }}
      >
        <div className="flow-library-heading">
          <strong>全部 Flow</strong>
          <span className="count">
            {flowCatalog.catalog ? flows.length : "—"}
          </span>
          <button
            className="icon-control"
            aria-label="刷新 Flow 列表"
            disabled={flowCatalog.refreshing}
            onClick={() => void flowCatalog.refresh()}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="icon-control flow-library-close"
            aria-label="关闭 Flow 列表"
            onClick={() => {
              setLibraryOpen(false);
              requestAnimationFrame(() => libraryToggle.current?.focus());
            }}
          >
            <X size={16} />
          </button>
        </div>
        <label className="flow-search">
          <Search size={14} />
          <input
            ref={searchInput}
            aria-label="搜索 Flow"
            placeholder="搜索名称或描述…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              className="icon-control"
              aria-label="清空 Flow 搜索"
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <div className="flow-library-filter">
          <span>
            {query || onlyAvailable ? `${filtered.length} 个结果` : "已注册"}
          </span>
          <button
            className="text-control"
            aria-pressed={onlyAvailable}
            onClick={() => setOnlyAvailable(!onlyAvailable)}
          >
            {onlyAvailable ? "显示全部" : "仅可运行"}
          </button>
        </div>
        <nav className="flow-library-list" aria-label="选择 Flow">
          {flowCatalog.error ? (
            <div className="flow-library-feedback" role="alert">
              <strong>暂时无法读取列表</strong>
              <span>
                {flowCatalog.catalog
                  ? "保留上次目录，正在重连。"
                  : "请检查服务连接，列表会自动重试。"}
              </span>
              <button
                className="text-control"
                onClick={() => void flowCatalog.refresh()}
              >
                重新连接
              </button>
            </div>
          ) : null}
          {!flowCatalog.catalog && !flowCatalog.error ? (
            <div className="flow-library-feedback" role="status">
              正在读取 Flow…
            </div>
          ) : null}
          {filtered.map((flow) => (
            <button
              key={flow.id}
              className={`flow-library-item${flowId === flow.id ? " selected" : ""}`}
              aria-label={`打开 Flow：${flow.title}`}
              aria-current={flowId === flow.id ? "true" : undefined}
              title={flow.error || flow.description || flow.id}
              onClick={() => selectFlow(flow.id)}
            >
              <span className="flow-list-name">
                <GitBranch size={14} />
                <strong>{flow.title}</strong>
              </span>
              <span className="flow-list-description">
                {flow.description || flow.error || "暂无描述"}
              </span>
              <span className="flow-list-meta">
                <span
                  className={`flow-library-status ${flow.available ? "available" : "unavailable"}`}
                />
                {flow.available ? "可运行" : "不可用"}
                <code>{flow.id}</code>
              </span>
            </button>
          ))}
          {flowCatalog.catalog && !filtered.length ? (
            <div className="flow-library-feedback">
              <strong>
                {flows.length ? "没有匹配的 Flow" : "暂无已注册 Flow"}
              </strong>
              <span>
                {flows.length
                  ? "试试其他关键词或显示全部。"
                  : "可先从下方本地草稿开始编写。"}
              </span>
              {flows.length ? (
                <button
                  className="text-control"
                  onClick={() => {
                    setQuery("");
                    setOnlyAvailable(false);
                  }}
                >
                  清除筛选
                </button>
              ) : null}
            </div>
          ) : null}
        </nav>
        <div className="flow-library-draft">
          <button
            className={isDraft ? "selected" : ""}
            aria-label="打开本地草稿"
            aria-current={isDraft ? "true" : undefined}
            onClick={() => selectFlow("")}
          >
            <FileCode2 size={15} />
            <span>
              <strong>本地草稿</strong>
              <small>{draftGraph.title}</small>
            </span>
          </button>
          <button
            className="icon-control"
            aria-label="导入 Flow 文件"
            title="导入到本地草稿"
            onClick={() => file.current?.click()}
          >
            <Upload size={15} />
          </button>
        </div>
      </aside>

      <div className="flow-content">
        <header className="flow-content-heading">
          <button
            className="tool-button flow-library-toggle"
            ref={libraryToggle}
            aria-expanded={libraryOpen}
            onClick={() => {
              setLibraryOpen(true);
              requestAnimationFrame(() => searchInput.current?.focus());
            }}
          >
            <List size={15} />
            <span>全部 Flow</span>
          </button>
          <div className="flow-content-title">
            <h1 title={title}>{title}</h1>
            <p title={description}>{description}</p>
          </div>
          <div className="flow-content-actions">
            {isDraft ? (
              <button className="tool-button accent" onClick={onAsk}>
                <Sparkles size={14} />
                <span>助手生成</span>
              </button>
            ) : view !== "runs" ? (
              <button
                className="primary-button"
                disabled={!selectedFlow?.available}
                onClick={() => setView("runs")}
              >
                <Play size={13} />
                运行
              </button>
            ) : null}
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
              <summary aria-label="Flow 更多操作">
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
          aria-label="Flow 工作区视图"
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
          {!isDraft ? (
            <button
              id="runs-tab"
              role="tab"
              aria-selected={view === "runs"}
              tabIndex={view === "runs" ? 0 : -1}
              aria-controls="runs-panel"
              onClick={() => setView("runs")}
            >
              <Play size={13} />
              运行记录
            </button>
          ) : null}
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
          aria-label="选择 Flow 文件"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (selected.size > 100_000) {
              setNotice("请选择小于 100 KB 的 Flow 文件。");
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
        {view !== "runs" && !isDraft && !source.source ? (
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
              aria-label={isDraft ? "Flow 代码编辑器" : "Flow 代码预览"}
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
        {!isDraft ? (
          <div
            id="runs-panel"
            role="tabpanel"
            aria-labelledby="runs-tab"
            className="runs-panel"
            hidden={view !== "runs"}
          >
            <FlowsScreen
              endpoint={endpoint}
              catalogState={flowCatalog}
              flowId={flowId}
            />
          </div>
        ) : null}
        {isDraft && view === "graph" ? (
          <div className="flow-draft-hint">
            草稿可编辑和导出，注册后即可运行。
          </div>
        ) : null}
      </div>
    </section>
  );
}
