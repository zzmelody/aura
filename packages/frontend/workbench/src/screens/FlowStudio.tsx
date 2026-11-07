import React, { useEffect, useRef, useState } from "react";
import { useWorkflowMessages, workflowMessage } from "../workflow-messages.ts";
import { messageText, type MessageReference } from "@aura/i18n/runtime";
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
import { flowTitle, flowDescription, flowCatalogError } from "../metadata.ts";
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
  const { t, i18n } = useWorkflowMessages();
  const [isDraft, setIsDraft] = useState(flowId === "");
  const [notice, setNotice] = useState<MessageReference>();
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
    ? (diagram?.title ?? t("draftTitle"))
    : selectedFlow
      ? flowTitle(selectedFlow, i18n)
      : t("removedTitle");
  const description = isDraft
    ? t("draftAutosave")
    : selectedFlow && flowDescription(selectedFlow, i18n);
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
    (isDraft && draft.saveError) ||
    flowCatalogError(selectedFlow, i18n) ||
    analysis.error;
  return (
    <section className="workflow-editor" aria-label={t("workflowDetails")}>
      <div className="flow-content">
        <header className="flow-content-heading">
          <button
            className="icon-control"
            aria-label={t("backWorkflows")}
            title={t("backWorkflows")}
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
              {isDraft
                ? draft.saved
                  ? t("saved")
                  : t("saving")
                : t("registered")}
            </span>
            {!isDraft ? (
              <button
                className="primary-button"
                disabled={!selectedFlow?.available}
                onClick={() => selectedFlow && onRun(selectedFlow)}
              >
                <Play size={13} />
                {t("run")}
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
              <summary aria-label={t("workflowMore")}>
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
                      {t("undoDraft")}
                    </button>
                    <button
                      onClick={() => {
                        file.current?.click();
                        closeMenu();
                      }}
                    >
                      <Upload size={14} />
                      {t("importDraft")}
                    </button>
                  </>
                ) : (
                  <button
                    disabled={!code}
                    onClick={() => {
                      draft.update(code);
                      setIsDraft(true);
                      closeMenu();
                      setNotice(workflowMessage("copiedDraft"));
                    }}
                  >
                    <FileCode2 size={14} />
                    {t("copyToDraft")}
                  </button>
                )}
                <button disabled={!code.trim()} onClick={download}>
                  <Download size={14} />
                  {t("exportCode")}
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
          aria-label={t("chooseWorkflowFile")}
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (selected.size > 100_000) {
              setNotice(workflowMessage("workflowFileTooLarge"));
              return;
            }
            try {
              draft.update(await selected.text());
              setIsDraft(true);
              closeMenu();
              setNotice(
                workflowMessage("importedDraft", { name: selected.name }),
              );
            } catch {
              setNotice(workflowMessage("workflowFileReadFailed"));
            }
          }}
        />
        {notice || error ? (
          <div className="editor-notice" role={error ? "alert" : "status"}>
            <span>{error || (notice && messageText(notice, i18n))}</span>
            {notice ? (
              <button
                className="icon-control"
                aria-label={t("closeNotice")}
                onClick={() => setNotice(undefined)}
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
                ? t("removedFromCatalog")
                : !selectedFlow.available
                  ? t("flowUnavailable")
                  : source.error
                    ? t("flowLoadFailed")
                    : t("loadingFlow")}
            </strong>
            <p>{source.error || flowCatalogError(selectedFlow, i18n)}</p>
            {source.error && selectedFlow?.available ? (
              <button className="tool-button" onClick={source.refresh}>
                <RefreshCw size={13} />
                {t("reloadFlow")}
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
            <strong>{t("analyzeFlowTitle")}</strong>
            <p>
              {t("analyzeFlowHint")}
              <br />
              {t("generatedGraphHint")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
