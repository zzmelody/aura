import React, { useEffect, useState } from "react";
import { useWorkflowMessages } from "../workflow-messages.ts";
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
import type { FlowAnalysisController } from "../useFlowAnalysis";
import { useFlowSource } from "../flowSource";
import { flowTitle, flowDescription, flowCatalogError } from "../metadata.ts";
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
  analysis,
}: {
  flow: FlowCatalogEntry;
  endpoint: string;
  onEdit(): void;
  analysis: FlowAnalysisController;
}) {
  const { t } = useWorkflowMessages();
  const { source, error, refresh } = useFlowSource(
    endpoint,
    flow.available ? flow.id : "",
    flow.revision ?? flow.sourceHash,
  );
  const diagram = analysis.entries.find(
    (entry) => entry.code === source?.code,
  )?.diagram;
  return (
    <div
      className="workflow-card-preview"
      id={`preview-${flow.id}`}
      role="region"
      aria-label={t("graphLabel", { name: flowTitle(flow) })}
    >
      <div className="workflow-preview-heading">
        <span>{t("preview")}</span>
        <span>{t("graphGestureHint")}</span>
      </div>
      {source ? (
        <React.Suspense
          fallback={
            <div className="flow-preview-empty">{t("loadingGraph")}</div>
          }
        >
          {diagram ? (
            <FlowGraphView diagram={diagram} embedded />
          ) : (
            <div className="flow-preview-empty">
              <p>{t("analyzeGraphHint")}</p>
              <button className="tool-button" onClick={onEdit}>
                {t("openWorkflow")}
              </button>
            </div>
          )}
        </React.Suspense>
      ) : (
        <div
          className="flow-preview-empty"
          role={error || !flow.available ? "alert" : "status"}
        >
          <span>
            {flowCatalogError(flow) ||
              error ||
              (!flow.available ? t("workflowUnavailable") : t("loadingGraph"))}
          </span>
          {error ? (
            <button className="tool-button" onClick={refresh}>
              {t("retry")}
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
  analysis,
  editorRevision,
  onRun,
  onDetailChange,
}: {
  browseRevision: number;
  endpoint: string;
  catalogState: FlowCatalogController;
  draft: FlowDraftController;
  analysis: FlowAnalysisController;
  editorRevision: number;
  onRun(flow: FlowCatalogEntry): void;
  onDetailChange(open: boolean): void;
}) {
  const { t } = useWorkflowMessages();
  const [editing, setEditing] = useState<string | null>(null);
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
      onDetailChange(true);
    }
  }, [editorRevision, onDetailChange]);
  const edit = (id: string) => {
    setEditing(id);
    onDetailChange(true);
  };
  const flows = catalogState.catalog?.flows ?? [];
  const visible = flows.filter((flow) =>
    `${flowTitle(flow)} ${flowDescription(flow)} ${flow.title} ${flow.description} ${flow.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  if (editing !== null)
    return (
      <React.Suspense
        fallback={<div className="workspace-loading">{t("loadingEditor")}</div>}
      >
        <FlowStudio
          key={editing}
          flowId={editing}
          endpoint={endpoint}
          catalogState={catalogState}
          draft={draft}
          analysis={analysis}
          onRun={onRun}
          onBack={() => {
            setEditing(null);
            onDetailChange(false);
          }}
        />
      </React.Suspense>
    );
  return (
    <section className="workflow-library-page" aria-label={t("library")}>
      <header className="workflow-page-heading">
        <div>
          <h1>{t("workflows")}</h1>
          <p>{t("libraryHint")}</p>
        </div>
        <button className="tool-button" onClick={() => edit("")}>
          <Plus size={16} />
          {t("createWorkflow")}
        </button>
      </header>
      <div className="workflow-page-tools">
        <label className="workflow-card-search">
          <Search size={16} />
          <input
            aria-label={t("searchWorkflows")}
            placeholder={t("searchWorkflowsPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              className="icon-control"
              aria-label={t("clearSearch")}
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          ) : null}
        </label>
        <span>
          {catalogState.catalog
            ? t("workflowCount", { count: visible.length })
            : t("loading")}
        </span>
        <button
          className="icon-control"
          aria-label={t("refreshWorkflows")}
          disabled={catalogState.refreshing}
          onClick={() => void catalogState.refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {catalogState.error ? (
        <div className="workspace-notice" role="alert">
          {t("serviceRetrying")}
          {catalogState.catalog ? t("cachedList") : ""}
          <button
            className="text-control"
            onClick={() => void catalogState.refresh()}
          >
            {t("reconnect")}
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
                aria-label={t(
                  expanded === flow.id ? "collapseWorkflow" : "expandWorkflow",
                  { name: flowTitle(flow) },
                )}
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
                  <strong>{flowTitle(flow)}</strong>
                  <span>{flowDescription(flow) || t("noDescription")}</span>
                </span>
                <ChevronDown className="workflow-expand-icon" size={15} />
              </button>
              <div className="workflow-card-actions">
                <span
                  className={`workflow-card-status${flow.available ? "" : " unavailable"}`}
                  title={flowCatalogError(flow)}
                >
                  <i />
                  {flow.available ? t("available") : t("unavailable")}
                </span>
                <button
                  className="icon-control row-control"
                  aria-label={t("editWorkflowLabel", { name: flowTitle(flow) })}
                  title={t("editWorkflow")}
                  onClick={() => edit(flow.id)}
                >
                  <Pencil size={17} />
                </button>
                <button
                  className="icon-control workflow-run-icon row-control"
                  disabled={!flow.available}
                  aria-label={t("runWorkflowLabel", { name: flowTitle(flow) })}
                  title={t("runWorkflow")}
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
                onEdit={() => edit(flow.id)}
                analysis={analysis}
              />
            ) : null}
          </article>
        ))}
        {catalogState.catalog && !visible.length ? (
          <div className="workflow-empty">
            <FlowIcon size={28} />
            <h2>{flows.length ? t("noMatches") : t("firstWorkflow")}</h2>
            <p>{flows.length ? t("tryKeyword") : t("createOrImport")}</p>
            <button
              className="tool-button"
              onClick={() => (flows.length ? setQuery("") : edit(""))}
            >
              {flows.length ? t("resetSearch") : t("createWorkflow")}
            </button>
          </div>
        ) : null}
      </div>
      <button className="workflow-draft-link" onClick={() => edit("")}>
        <FileCode2 size={16} />
        <span>{t("continueDraft")}</span>
      </button>
    </section>
  );
}
