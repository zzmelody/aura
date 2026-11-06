import React from "react";
import {
  AlertCircle,
  Check,
  CirclePlus,
  ExternalLink,
  FolderOpen,
  Globe2,
  LoaderCircle,
  Play,
  Server,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { platform } from "@aura/workbench/plugin";
import { messageText } from "@aura/plugin-ui";
import { useSiteProjects, type SiteHostApi } from "./site";
import type { SiteStatus } from "@aura/protocol/types";
import {
  useSiteMessages,
  isSiteMessageKey,
  siteStatusText,
  sitePortText,
} from "./messages";

function statusTone(state: SiteStatus["state"]): string {
  return state === "running"
    ? "online"
    : state === "error"
      ? "error"
      : state === "starting" || state === "stopping"
        ? "working"
        : "idle";
}

function shortPath(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : directory;
}

export function SiteScreen({ host }: { host?: SiteHostApi }) {
  const { t, i18n } = useSiteMessages();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage, {
    minimumIntegerDigits: 2,
  });
  const site = useSiteProjects(host);
  const project = site.selected;
  const status = site.selectedStatus;
  const active =
    Boolean(status.pid) ||
    status.state === "starting" ||
    status.state === "stopping";
  const desktop = platform() === "desktop";

  return (
    <section className="site-page" aria-label={t("runner")}>
      <div className="site-page-inner">
        <header className="site-hero site-hero-compact">
          <div className="site-hero-copy">
            <span className="site-eyebrow">{t("eyebrow")}</span>
            <h1>{t("headline")}</h1>
            <p>{t("description")}</p>
          </div>
          <div className="site-hero-stats" aria-label={t("overview")}>
            <strong>{number.format(site.projects.length)}</strong>
            <span>{t("savedProjects")}</span>
            <i />
            <strong>{number.format(site.runningCount)}</strong>
            <span>{t("runningProjects")}</span>
          </div>
        </header>

        {site.chooseError !== undefined ? (
          <p className="site-port-message" role="alert">
            {typeof site.chooseError === "string" &&
            isSiteMessageKey(site.chooseError)
              ? t(site.chooseError)
              : messageText(site.chooseError, i18n)}
          </p>
        ) : null}
        {!desktop || !site.available ? (
          <div className="site-unavailable" role="status">
            <MonitorOnly />
            <div>
              <strong>
                {desktop ? t("desktopNotReady") : t("desktopOnly")}
              </strong>
              <p>{desktop ? t("restartDesktop") : t("openDesktop")}</p>
            </div>
          </div>
        ) : (
          <div className="site-console">
            <aside className="site-project-list" aria-label={t("projectList")}>
              <div className="site-list-heading">
                <div>
                  <span className="site-card-kicker">{t("projects")}</span>
                  <strong>{t("mySites")}</strong>
                </div>
                <button
                  className="icon-control"
                  aria-label={t("addProject")}
                  title={t("addProject")}
                  onClick={() => void site.chooseDirectory()}
                  disabled={site.busyIds.size > 0}
                >
                  <CirclePlus size={18} />
                </button>
              </div>
              <button
                className="site-add-project"
                onClick={() => void site.chooseDirectory()}
                disabled={site.busyIds.size > 0}
              >
                <FolderOpen size={15} />
                {t("addDirectory")}
              </button>
              <div className="site-list-items">
                {site.projects.map((item) => {
                  const itemStatus = site.statuses[item.id] ?? {
                    state: "idle" as const,
                  };
                  const selected = item.id === site.selectedId;
                  return (
                    <button
                      key={item.id}
                      className={`site-project-item${selected ? " selected" : ""}`}
                      onClick={() => site.select(item.id)}
                      aria-pressed={selected}
                    >
                      <span
                        className={`site-list-dot ${statusTone(itemStatus.state)}`}
                      />
                      <span className="site-project-item-copy">
                        <strong>{item.name}</strong>
                        <small>{shortPath(item.directory)}</small>
                      </span>
                      {itemStatus.previewReady ? (
                        <Check size={14} className="site-list-check" />
                      ) : null}
                    </button>
                  );
                })}
                {!site.projects.length ? (
                  <div className="site-list-empty">
                    <Server size={20} />
                    <span>
                      {t("noProjects")}
                      <br />
                      {t("addFirst")}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="site-list-note">
                <span className="site-list-dot online" />
                {t("independent")}
              </div>
            </aside>

            {project ? (
              <ProjectDetail
                site={site}
                project={project}
                status={status}
                active={active}
              />
            ) : (
              <EmptyDetail onAdd={() => void site.chooseDirectory()} />
            )}
          </div>
        )}

        <footer className="site-footnote">
          <span>{t("processNote")}</span>
          <span>
            {desktop
              ? t("previewCount", { count: site.runningCount })
              : t("desktopRequired")}
          </span>
        </footer>
      </div>
    </section>
  );
}

function ProjectDetail({
  site,
  project,
  status,
  active,
}: {
  site: ReturnType<typeof useSiteProjects>;
  project: NonNullable<ReturnType<typeof useSiteProjects>["selected"]>;
  status: ReturnType<typeof useSiteProjects>["selectedStatus"];
  active: boolean;
}) {
  const { t, i18n } = useSiteMessages();
  const busy = site.busyIds.has(project.id);
  const portMessage = sitePortText(status.portDetails, status.portMessage, t);
  return (
    <main className="site-detail">
      <div className="site-detail-heading">
        <div className="site-detail-title">
          <span className={`site-status-dot ${statusTone(status.state)}`} />
          <div>
            <span className="site-card-kicker">{t("selectedProject")}</span>
            <h2>{project.name}</h2>
            <p title={project.directory}>{project.directory}</p>
          </div>
        </div>
        <button
          className="icon-control site-delete"
          aria-label={t("removeProject")}
          title={t("removeFromList")}
          onClick={() => site.remove(project.id)}
          disabled={busy || active}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div className="site-detail-grid">
        <section className="site-config-card">
          <div className="site-section-label">
            <Terminal size={14} />
            {t("configuration")}
          </div>
          <div className="site-fields">
            <label>
              <span>{t("script")}</span>
              <select
                value={project.script}
                disabled={active || busy}
                onChange={(event) =>
                  site.updateProject(project.id, { script: event.target.value })
                }
              >
                {project.scripts.map((script) => (
                  <option key={script} value={script}>
                    {project.packageManager} run {script}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("previewAddress")}</span>
              <input
                value={project.url}
                disabled={active || busy}
                spellCheck={false}
                onChange={(event) =>
                  site.updateProject(project.id, { url: event.target.value })
                }
              />
            </label>
          </div>
          <div className="site-project-meta">
            <span>
              <Terminal size={13} /> {project.packageManager}
            </span>
            <span>{t("scriptCount", { count: project.scripts.length })}</span>
          </div>
          <p className="site-port-help">{t("portHelp")}</p>
        </section>
        <section className={`site-run-card${active ? " active" : ""}`}>
          <div className="site-run-heading">
            <span className={`site-status-dot ${statusTone(status.state)}`} />
            <span>{t("runStatus")}</span>
            <strong>{t(status.state)}</strong>
          </div>
          <div className="site-run-body">
            {status.state === "error" ? (
              <AlertCircle size={25} className="site-run-icon error" />
            ) : active ? (
              <LoaderCircle size={25} className="site-run-icon spinning" />
            ) : (
              <Play size={25} className="site-run-icon" />
            )}
            <p>
              {(status.errorText !== undefined
                ? typeof status.errorText === "string" &&
                  isSiteMessageKey(status.errorText)
                  ? t(status.errorText)
                  : messageText(status.errorText, i18n)
                : status.messageKey
                  ? t(status.messageKey)
                  : siteStatusText(
                      status.messageDetails,
                      status.message && isSiteMessageKey(status.message)
                        ? t(status.message)
                        : status.message,
                      t,
                    )) ??
                (status.previewReady
                  ? t("previewReady", { url: project.url })
                  : t("autoPreview"))}
            </p>
          </div>
          {portMessage ? (
            <p className="site-port-message" role="status">
              {portMessage}
            </p>
          ) : null}
          <div className="site-run-actions">
            {active ? (
              <button
                className="primary-button site-stop-button"
                disabled={busy || status.state === "stopping"}
                onClick={() => void site.stop(project.id)}
              >
                <Square size={14} />
                {t("stopProject")}
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void site.run(project.id)}
              >
                <Play size={14} /> {busy ? t("preparing") : t("runProject")}
              </button>
            )}
            {status.previewReady ? (
              <button
                className="tool-button"
                disabled={busy}
                onClick={() => void site.open(project.id)}
              >
                <ExternalLink size={14} />
                {t("openPreview")}
              </button>
            ) : null}
          </div>
          {status.output ? (
            <pre className="site-output" aria-label={t("output")}>
              {status.output}
            </pre>
          ) : null}
        </section>
      </div>
      <div className="site-detail-footer">
        <span>
          <Globe2 size={14} />{" "}
          {status.previewReady ? t("previewLinked") : t("previewWillOpen")}
        </span>
        <span>{status.pid ? `PID ${status.pid}` : t("notStarted")}</span>
      </div>
    </main>
  );
}

function EmptyDetail({ onAdd }: { onAdd(): void }) {
  const { t } = useSiteMessages();
  return (
    <main className="site-detail site-detail-empty">
      <Globe2 size={40} className="aura-icon--display aura-icon--muted" />
      <h2>{t("selectProject")}</h2>
      <p>{t("selectHint")}</p>
      <button className="primary-button" onClick={onAdd}>
        <FolderOpen size={15} />
        {t("addDirectory")}
      </button>
    </main>
  );
}

function MonitorOnly() {
  return (
    <span className="site-unavailable-icon" aria-hidden="true">
      <Globe2 size={22} />
    </span>
  );
}
