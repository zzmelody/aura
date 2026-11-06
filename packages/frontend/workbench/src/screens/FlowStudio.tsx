import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  FileCode2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Undo2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { FlowGraphView } from "./FlowGraphView";
import type { FlowCatalogController } from "../flowCatalog";
import type { FlowCatalogEntry } from "@aura/protocol/types";
import { useFlowSource } from "../flowSource";
import type { FlowDraftController } from "../flowDraft";
import type { FlowAnalysisController } from "../useFlowAnalysis";

export function FlowStudio({
  endpoint,
  draft,
  analysis,
  flowId,
  catalogState,
  onBack,
  onRun,
}: {
  endpoint: string;
  draft: FlowDraftController;
  analysis: FlowAnalysisController;
  flowId: string;
  catalogState: FlowCatalogController;
  onBack(): void;
  onRun(flow: FlowCatalogEntry): void;
}) {
  const [isDraft, setIsDraft] = useState(flowId === "");
  const [notice, setNotice] = useState("");
  const selectedFlow = isDraft
    ? undefined
    : catalogState.catalog?.flows.find((flow) => flow.id === flowId);
  const source = useFlowSource(
    endpoint,
    selectedFlow?.available ? flowId : "",
    selectedFlow?.revision ?? selectedFlow?.sourceHash,
  );
  const code = isDraft ? draft.code : (source.source?.code ?? "");
  const diagram = analysis.entries.find(
    (entry) => entry.code === code,
  )?.diagram;
  const title = isDraft
    ? (diagram?.title ?? "工作流草稿")
    : (selectedFlow?.title ?? "工作流已移除");
  const description = isDraft
    ? "本地草稿 · 自动保存"
    : selectedFlow?.description;
  const { selectSource } = analysis;
  useEffect(() => {
    selectSource(`${endpoint}:${isDraft ? "draft" : flowId}`, code);
    return () => selectSource("", "");
  }, [selectSource, endpoint, isDraft, flowId, code]);
  const file = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  function closeMenu() {
    if (menu.current) menu.current.open = false;
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
    closeMenu();
  }
  const error =
    (isDraft && draft.saveError) || selectedFlow?.error || analysis.error;
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
            <span className="flow-view-status">
              {isDraft ? (draft.saved ? "已保存" : "保存中…") : "已注册"}
            </span>
            {!isDraft ? (
              <button
                className="primary-button"
                disabled={!selectedFlow?.available}
                onClick={() => selectedFlow && onRun(selectedFlow)}
              >
                <Play size={13} />
                运行
              </button>
            ) : null}
            <details
              className="flow-more"
              ref={menu}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeMenu();
                  menu.current?.querySelector("summary")?.focus();
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
                        closeMenu();
                      }}
                    >
                      <Undo2 size={14} />
                      撤销草稿替换
                    </button>
                    <button
                      onClick={() => {
                        file.current?.click();
                        closeMenu();
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
                      setIsDraft(true);
                      closeMenu();
                      setNotice("已复制到本地草稿，可通过右侧对话修改并导出。");
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
        <input
          type="file"
          hidden
          ref={file}
          accept=".js,.ts,.txt"
          aria-label="选择工作流文件"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (selected.size > 100_000) {
              setNotice("请选择小于 100 KB 的工作流文件。");
              return;
            }
            try {
              draft.update(await selected.text());
              setIsDraft(true);
              closeMenu();
              setNotice(
                `已导入 ${selected.name}，在右侧发送消息即可分析流程。`,
              );
            } catch {
              setNotice("文件读取失败，请重试。");
            }
          }}
        />
        {notice || error ? (
          <div className="editor-notice" role={error ? "alert" : "status"}>
            <span>{error || notice}</span>
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
            <Workflow size={28} className="aura-icon--display" />
            <strong>
              {!selectedFlow
                ? "这个 Flow 已从目录移除"
                : !selectedFlow.available
                  ? "Flow 暂不可用"
                  : source.error
                    ? "无法加载流程"
                    : "正在加载流程…"}
            </strong>
            <p>{source.error || selectedFlow?.error}</p>
            {source.error && selectedFlow?.available ? (
              <button className="tool-button" onClick={source.refresh}>
                <RefreshCw size={13} />
                重新加载
              </button>
            ) : null}
          </div>
        ) : diagram ? (
          <FlowGraphView diagram={diagram} />
        ) : (
          <div className="flow-preview-empty flow-analysis-empty">
            <span className="flow-analysis-symbol">
              <Workflow size={28} />
            </span>
            <strong>让 Agent 读懂这个流程</strong>
            <p>
              在右侧描述你的想法，或让助手分析当前流程。
              <br />
              生成的 SVG 流程图会显示在这里。
            </p>
          </div>
        )}
        {isDraft ? (
          <div className="flow-draft-hint">
            通过右侧对话完善流程，导出并注册后即可运行。
          </div>
        ) : null}
      </div>
    </section>
  );
}
