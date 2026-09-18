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
import { platform } from "../platform";
import { useSiteProjects } from "../site";
import type { SiteStatus } from "@aura/protocol/types";

function statusCopy(state: SiteStatus["state"]): string {
  if (state === "starting") return "启动中";
  if (state === "stopping") return "停止中";
  if (state === "running") return "运行中";
  if (state === "stopped") return "已停止";
  if (state === "error") return "需要处理";
  return "待运行";
}

function statusTone(state: SiteStatus["state"]): string {
  return state === "running" ? "online" : state === "error" ? "error" : state === "starting" || state === "stopping" ? "working" : "idle";
}

function shortPath(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : directory;
}

export function SiteScreen() {
  const site = useSiteProjects();
  const project = site.selected;
  const status = site.selectedStatus;
  const active = Boolean(status.pid) || status.state === "starting" || status.state === "stopping";
  const desktop = platform() === "desktop";

  return (
    <section className="site-page" aria-label="Site 本地项目运行器">
      <div className="site-page-inner">
        <header className="site-hero site-hero-compact">
          <div className="site-hero-copy">
            <span className="site-eyebrow">LOCAL / SITE RUNNER</span>
            <h1>本地站点，一处管理。</h1>
            <p>把常用前端项目放在这里。每个项目都有独立的启动进程、预览窗口和端口。</p>
          </div>
          <div className="site-hero-stats" aria-label="Site 概览">
            <strong>{site.projects.length.toString().padStart(2, "0")}</strong>
            <span>已保存项目</span>
            <i />
            <strong>{site.runningCount.toString().padStart(2, "0")}</strong>
            <span>正在运行</span>
          </div>
        </header>

        {!desktop || !site.available ? (
          <div className="site-unavailable" role="status">
            <MonitorOnly />
            <div>
              <strong>{desktop ? "桌面连接未就绪" : "本机目录运行仅支持 Aura Desktop"}</strong>
              <p>{desktop ? "请完全退出 Aura，然后重新运行 pnpm desktop，以加载目录选择和项目运行功能。" : "在桌面版中打开这个菜单，就可以选择目录并运行前端项目。"}</p>
            </div>
          </div>
        ) : (
          <div className="site-console">
            <aside className="site-project-list" aria-label="Site 项目列表">
              <div className="site-list-heading">
                <div><span className="site-card-kicker">PROJECTS</span><strong>我的站点</strong></div>
                <button className="icon-control" aria-label="添加项目" title="添加项目" onClick={() => void site.chooseDirectory()} disabled={site.busyIds.size > 0}>
                  <CirclePlus size={18} />
                </button>
              </div>
              <button className="site-add-project" onClick={() => void site.chooseDirectory()} disabled={site.busyIds.size > 0}>
                <FolderOpen size={15} /> 添加项目目录
              </button>
              <div className="site-list-items">
                {site.projects.map((item) => {
                  const itemStatus = site.statuses[item.id] ?? { state: "idle" as const };
                  const selected = item.id === site.selectedId;
                  return (
                    <button key={item.id} className={`site-project-item${selected ? " selected" : ""}`} onClick={() => site.select(item.id)} aria-pressed={selected}>
                      <span className={`site-list-dot ${statusTone(itemStatus.state)}`} />
                      <span className="site-project-item-copy"><strong>{item.name}</strong><small>{shortPath(item.directory)}</small></span>
                      {itemStatus.previewReady ? <Check size={14} className="site-list-check" /> : null}
                    </button>
                  );
                })}
                {!site.projects.length ? <div className="site-list-empty"><Server size={20} /><span>还没有项目<br />添加一个目录开始</span></div> : null}
              </div>
              <div className="site-list-note"><span className="site-list-dot online" />每个项目可以独立运行</div>
            </aside>

            {project ? <ProjectDetail site={site} project={project} status={status} active={active} /> : <EmptyDetail onAdd={() => void site.chooseDirectory()} />}
          </div>
        )}

        <footer className="site-footnote"><span>LOCAL PROCESS · PORTS AUTO ASSIGNED</span><span>{desktop ? `${site.runningCount} 个项目可独立预览` : "需要桌面版"}</span></footer>
      </div>
    </section>
  );
}

function ProjectDetail({ site, project, status, active }: { site: ReturnType<typeof useSiteProjects>; project: NonNullable<ReturnType<typeof useSiteProjects>["selected"]>; status: SiteStatus; active: boolean }) {
  const busy = site.busyIds.has(project.id);
  return (
    <main className="site-detail">
      <div className="site-detail-heading">
        <div className="site-detail-title"><span className={`site-status-dot ${statusTone(status.state)}`} /><div><span className="site-card-kicker">SELECTED PROJECT</span><h2>{project.name}</h2><p title={project.directory}>{project.directory}</p></div></div>
        <button className="icon-control site-delete" aria-label="移除项目" title="从列表移除" onClick={() => site.remove(project.id)} disabled={busy || active}><Trash2 size={16} /></button>
      </div>
      <div className="site-detail-grid">
        <section className="site-config-card">
          <div className="site-section-label"><Terminal size={14} /> 项目配置</div>
          <div className="site-fields">
            <label><span>启动脚本</span><select value={project.script} disabled={active || busy} onChange={(event) => site.updateProject(project.id, { script: event.target.value })}>{project.scripts.map((script) => <option key={script} value={script}>{project.packageManager} run {script}</option>)}</select></label>
            <label><span>预览地址（默认端口）</span><input value={project.url} disabled={active || busy} spellCheck={false} onChange={(event) => site.updateProject(project.id, { url: event.target.value })} /></label>
          </div>
          <div className="site-project-meta"><span><Terminal size={13} /> {project.packageManager}</span><span>{project.scripts.length} 个可用脚本</span></div>
          <p className="site-port-help">已识别的开发服务器会从默认端口开始自动寻找可用端口。多个项目可以同时运行。</p>
        </section>
        <section className={`site-run-card${active ? " active" : ""}`}>
          <div className="site-run-heading"><span className={`site-status-dot ${statusTone(status.state)}`} /><span>运行状态</span><strong>{statusCopy(status.state)}</strong></div>
          <div className="site-run-body">{status.state === "error" ? <AlertCircle size={25} className="site-run-icon error" /> : active ? <LoaderCircle size={25} className="site-run-icon spinning" /> : <Play size={25} className="site-run-icon" />}<p>{status.message ?? (status.previewReady ? `预览已就绪：${project.url}` : "运行脚本后会自动打开独立预览窗口。")}</p></div>
          {status.portMessage ? <p className="site-port-message" role="status">{status.portMessage}</p> : null}
          <div className="site-run-actions">{active ? <button className="primary-button site-stop-button" disabled={busy || status.state === "stopping"} onClick={() => void site.stop(project.id)}><Square size={14} /> 停止项目</button> : <button className="primary-button" disabled={busy} onClick={() => void site.run(project.id)}><Play size={14} /> {busy ? "正在准备…" : "运行项目"}</button>}{status.previewReady ? <button className="tool-button" disabled={busy} onClick={() => void site.open(project.id)}><ExternalLink size={14} /> 打开预览</button> : null}</div>
          {status.output ? <pre className="site-output" aria-label="项目输出">{status.output}</pre> : null}
        </section>
      </div>
      <div className="site-detail-footer"><span><Globe2 size={14} /> {status.previewReady ? "预览窗口已关联" : "预览窗口将在服务就绪后打开"}</span><span>{status.pid ? `PID ${status.pid}` : "尚未启动"}</span></div>
    </main>
  );
}

function EmptyDetail({ onAdd }: { onAdd(): void }) {
  return <main className="site-detail site-detail-empty"><Globe2 size={40} /><h2>选择一个项目</h2><p>从左侧添加或选择一个前端项目，开始本地预览。</p><button className="primary-button" onClick={onAdd}><FolderOpen size={15} /> 添加项目目录</button></main>;
}

function MonitorOnly() { return <span className="site-unavailable-icon" aria-hidden="true"><Globe2 size={22} /></span>; }
