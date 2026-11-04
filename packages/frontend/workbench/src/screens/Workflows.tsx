import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  FileCode2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import type { FlowCatalogEntry } from "@aura/protocol/types";
import type { FlowCatalogController } from "../flowCatalog";
import type { FlowDraftController } from "../flowDraft";
import { useFlowSource } from "../flowSource";
const FlowGraphView = React.lazy(() =>
  import("./FlowGraphView").then((module) => ({
    default: module.FlowGraphView,
  })),
);
const FlowStudio = React.lazy(() =>
  import("./FlowStudio").then((module) => ({ default: module.FlowStudio })),
);

function WorkflowPreview({
  flow,
  endpoint,
  onEdit,
}: {
  flow: FlowCatalogEntry;
  endpoint: string;
  onEdit(line?: number): void;
}) {
  const { source, error, refresh } = useFlowSource(
    endpoint,
    flow.available ? flow.id : "",
    flow.revision ?? flow.sourceHash,
  );
  return (
    <div
      className="workflow-card-preview"
      id={`preview-${flow.id}`}
      role="region"
      aria-label={`${flow.title}的节点图`}
    >
      <div className="workflow-preview-heading">
        <span>流程预览</span>
        <span>滚轮缩放 · 双指平移 / 捏合</span>
      </div>
      {source ? (
        <React.Suspense
          fallback={<div className="flow-preview-empty">正在加载节点图…</div>}
        >
          <FlowGraphView code={source.code} onOpenCode={onEdit} embedded />
        </React.Suspense>
      ) : (
        <div
          className="flow-preview-empty"
          role={error || !flow.available ? "alert" : "status"}
        >
          <span>
            {flow.error ||
              error ||
              (!flow.available ? "此工作流当前不可用。" : "正在加载节点图…")}
          </span>
          {error ? (
            <button className="tool-button" onClick={refresh}>
              重试
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function Workflows({
  browseRevision,
  endpoint,
  catalogState,
  draft,
  editorRevision,
  onAsk,
  onRun,
  onDetailChange,
}: {
  browseRevision: number;
  endpoint: string;
  catalogState: FlowCatalogController;
  draft: FlowDraftController;
  editorRevision: number;
  onAsk(): void;
  onRun(flow: FlowCatalogEntry): void;
  onDetailChange(open: boolean): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [initialLine, setInitialLine] = useState<number>();
  const [expanded, setExpanded] = useState<string>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    setEditing(null);
    onDetailChange(false);
  }, [browseRevision, onDetailChange]);
  useEffect(() => {
    setEditing(null);
    setExpanded(undefined);
    onDetailChange(false);
  }, [endpoint, onDetailChange]);
  useEffect(() => {
    if (editorRevision) {
      setEditing("");
      setInitialLine(undefined);
      onDetailChange(true);
    }
  }, [editorRevision, onDetailChange]);
  const edit = (id: string, line?: number) => {
    setEditing(id);
    setInitialLine(line);
    onDetailChange(true);
  };
  const flows = catalogState.catalog?.flows ?? [];
  const visible = flows.filter((flow) =>
    `${flow.title} ${flow.description} ${flow.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  if (editing !== null)
    return (
      <React.Suspense
        fallback={<div className="workspace-loading">正在加载编辑器…</div>}
      >
        <FlowStudio
          key={editing}
          flowId={editing}
          initialLine={initialLine}
          endpoint={endpoint}
          catalogState={catalogState}
          draft={draft}
          editorRevision={0}
          onAsk={onAsk}
          onRun={onRun}
          onBack={() => {
            setEditing(null);
            onDetailChange(false);
          }}
        />
      </React.Suspense>
    );
  return (
    <section className="workflow-library-page" aria-label="工作流列表">
      <header className="workflow-page-heading">
        <div>
          <h1>工作流</h1>
          <p>底层能力目录。可在这里运行，也可在任何对话中输入 / 调用。</p>
        </div>
        <button className="tool-button" onClick={() => edit("")}>
          <Plus size={16} />
          创建工作流
        </button>
      </header>
      <div className="workflow-page-tools">
        <label className="workflow-card-search">
          <Search size={16} />
          <input
            aria-label="搜索工作流"
            placeholder="搜索工作流…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              className="icon-control"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          ) : null}
        </label>
        <span>
          {catalogState.catalog ? `${visible.length} 个工作流` : "加载中"}
        </span>
        <button
          className="icon-control"
          aria-label="刷新工作流"
          disabled={catalogState.refreshing}
          onClick={() => void catalogState.refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {catalogState.error ? (
        <div className="workspace-notice" role="alert">
          暂时无法连接工作流服务，正在重试。
          {catalogState.catalog ? "已保留上次列表。" : ""}
          <button
            className="text-control"
            onClick={() => void catalogState.refresh()}
          >
            重新连接
          </button>
        </div>
      ) : null}
      <div className="workflow-cards">
        {visible.map((flow) => (
          <article
            className={`workflow-card${expanded === flow.id ? " expanded" : ""}`}
            key={flow.id}
          >
            <div className="workflow-card-summary" data-row-highlight>
              <button
                className="workflow-card-open row-control"
                aria-label={`${expanded === flow.id ? "收起" : "展开"}工作流：${flow.title}`}
                aria-expanded={expanded === flow.id}
                aria-controls={`preview-${flow.id}`}
                onClick={() =>
                  setExpanded(expanded === flow.id ? undefined : flow.id)
                }
              >
                <span className="workflow-card-icon">
                  <FlowIcon size={22} />
                </span>
                <span className="workflow-card-copy">
                  <strong>{flow.title}</strong>
                  <span>{flow.description || "暂无说明"}</span>
                </span>
                <ChevronDown className="workflow-expand-icon" size={15} />
              </button>
              <div className="workflow-card-actions">
                <span
                  className={`workflow-card-status${flow.available ? "" : " unavailable"}`}
                  title={flow.error}
                >
                  <i />
                  {flow.available ? "可运行" : "不可用"}
                </span>
                <button
                  className="icon-control row-control"
                  aria-label={`编辑工作流：${flow.title}`}
                  title="编辑工作流"
                  onClick={() => edit(flow.id)}
                >
                  <Pencil size={17} />
                </button>
                <button
                  className="icon-control workflow-run-icon row-control"
                  disabled={!flow.available}
                  aria-label={`运行工作流：${flow.title}`}
                  title="运行工作流"
                  onClick={() => onRun(flow)}
                >
                  <Play size={17} />
                </button>
              </div>
            </div>
            {expanded === flow.id ? (
              <WorkflowPreview
                flow={flow}
                endpoint={endpoint}
                onEdit={(line) => edit(flow.id, line)}
              />
            ) : null}
          </article>
        ))}
        {catalogState.catalog && !visible.length ? (
          <div className="workflow-empty">
            <FlowIcon size={28} />
            <h2>{flows.length ? "没有匹配的工作流" : "从第一个工作流开始"}</h2>
            <p>
              {flows.length
                ? "换个关键词试试。"
                : "创建草稿，或导入已有的工作流代码。"}
            </p>
            <button
              className="tool-button"
              onClick={() => (flows.length ? setQuery("") : edit(""))}
            >
              {flows.length ? "清除搜索" : "创建工作流"}
            </button>
          </div>
        ) : null}
      </div>
      <button className="workflow-draft-link" onClick={() => edit("")}>
        <FileCode2 size={16} />
        <span>继续编辑本地草稿</span>
      </button>
    </section>
  );
}
