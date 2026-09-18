import React from "react";
import {
  AlertCircle,
  ExternalLink,
  FolderOpen,
  Globe2,
  LoaderCircle,
  Play,
  Square,
  Terminal,
} from "lucide-react";
import { platform } from "../platform";
import { useSiteProject } from "../site";

function statusCopy(
  state: ReturnType<typeof useSiteProject>["status"]["state"],
): string {
  if (state === "starting") return "启动中";
  if (state === "stopping") return "停止中";
  if (state === "running") return "运行中";
  if (state === "stopped") return "已停止";
  if (state === "error") return "需要处理";
  return "尚未运行";
}

export function SiteScreen() {
  const site = useSiteProject();
  const project = site.project;
  const active =
    Boolean(site.status.pid) ||
    site.status.state === "starting" ||
    site.status.state === "stopping";
  const desktop = platform() === "desktop";

  return (
    <section className="site-page" aria-label="Site 本地项目运行器">
      <div className="site-page-inner">
        <header className="site-hero">
          <div className="site-hero-copy">
            <span className="site-eyebrow">LOCAL / SITE RUNNER</span>
            <h1>把一个前端项目，变成可打开的站点。</h1>
            <p>
              选择项目目录，Aura
              会识别它的包管理器和开发脚本。运行后，在独立窗口里预览你的本地页面。
            </p>
          </div>
          <div className="site-signal" aria-hidden="true">
            <div className="site-signal-ring" />
            <Globe2 size={31} strokeWidth={1.25} />
            <span>READY / LOCAL</span>
          </div>
        </header>

        {!desktop || !site.available ? (
          <div className="site-unavailable" role="status">
            <MonitorOnly />
            <div>
              <strong>
                {desktop ? "桌面连接未就绪" : "本机目录运行仅支持 Aura Desktop"}
              </strong>
              <p>
                {desktop
                  ? "请完全退出 Aura，然后重新运行 pnpm desktop，以加载目录选择和项目运行功能。"
                  : "在桌面版中打开这个菜单，就可以选择目录并运行前端项目。"}
              </p>
            </div>
          </div>
        ) : (
          <div className="site-layout">
            <section className="site-project-card">
              <div className="site-card-heading">
                <div>
                  <span className="site-card-kicker">PROJECT</span>
                  <h2>{project?.name ?? "还没有项目"}</h2>
                </div>
                <button
                  className="tool-button"
                  onClick={() => void site.chooseDirectory()}
                  disabled={site.busy || active}
                >
                  <FolderOpen size={15} />
                  {project ? "更换目录" : "选择目录"}
                </button>
              </div>

              {project ? (
                <>
                  <div className="site-path" title={project.directory}>
                    <FolderOpen size={15} />
                    <span>{project.directory}</span>
                  </div>
                  <div className="site-fields">
                    <label>
                      <span>启动脚本</span>
                      <select
                        value={project.script}
                        disabled={active || site.busy}
                        onChange={(event) =>
                          site.updateProject({ script: event.target.value })
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
                      <span>预览地址（本机）</span>
                      <input
                        value={project.url}
                        disabled={active || site.busy}
                        spellCheck={false}
                        onChange={(event) =>
                          site.updateProject({ url: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="site-project-meta">
                    <span>
                      <Terminal size={13} /> {project.packageManager}
                    </span>
                    <span>{project.scripts.length} 个可用脚本</span>
                  </div>
                  <p className="site-port-help">
                    Vite、Next.js、Angular CLI、Vue CLI
                    的直接启动脚本遇到端口占用时会自动换端口；自定义脚本需自行匹配监听端口。
                  </p>
                </>
              ) : (
                <button
                  className="site-empty-project"
                  onClick={() => void site.chooseDirectory()}
                  disabled={site.busy}
                >
                  <FolderOpen size={25} strokeWidth={1.3} />
                  <strong>从一个前端项目开始</strong>
                  <span>目录里需要有 package.json</span>
                </button>
              )}
            </section>

            <aside className={`site-run-card${active ? " active" : ""}`}>
              <div className="site-run-heading">
                <span className={`site-status-dot ${site.status.state}`} />
                <span>运行状态</span>
                <strong>{statusCopy(site.status.state)}</strong>
              </div>
              <div className="site-run-body">
                {site.status.state === "error" ? (
                  <AlertCircle size={24} className="site-run-icon error" />
                ) : active ? (
                  <LoaderCircle size={24} className="site-run-icon spinning" />
                ) : (
                  <Play size={24} className="site-run-icon" />
                )}
                <p>
                  {site.status.message ??
                    (project
                      ? "准备好后，运行脚本并打开本地预览。"
                      : "先选择一个项目目录。")}
                </p>
              </div>
              {site.status.portMessage ? (
                <p className="site-port-message" role="status">
                  {site.status.portMessage}
                </p>
              ) : null}
              <div className="site-run-actions">
                {active ? (
                  <button
                    className="primary-button site-stop-button"
                    disabled={site.busy || site.status.state === "stopping"}
                    onClick={() => void site.stop()}
                  >
                    <Square size={14} />
                    停止项目
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={!project || site.busy}
                    onClick={() => void site.run()}
                  >
                    <Play size={14} />
                    {site.busy ? "正在准备…" : "运行项目"}
                  </button>
                )}
                {project ? (
                  <button
                    className="tool-button"
                    disabled={site.busy || !site.status.previewReady}
                    onClick={() => void site.open()}
                  >
                    <ExternalLink size={14} />
                    打开预览
                  </button>
                ) : null}
              </div>
              {site.status.output ? (
                <pre className="site-output" aria-label="项目输出">
                  {site.status.output}
                </pre>
              ) : null}
            </aside>
          </div>
        )}

        <footer className="site-footnote">
          <span>LOCAL PROCESS · NO CREDENTIALS SHARED</span>
          <span>{desktop ? "命令在项目目录内运行" : "需要桌面版"}</span>
        </footer>
      </div>
    </section>
  );
}

function MonitorOnly() {
  return (
    <span className="site-unavailable-icon" aria-hidden="true">
      <Globe2 size={22} />
    </span>
  );
}
