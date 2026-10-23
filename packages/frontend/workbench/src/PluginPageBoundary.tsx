import React from "react";

/** Isolates a plugin page so a render error cannot unmount the workbench. */
export class PluginPageBoundary extends React.Component<
  { label: string; renderPage: () => React.ReactNode },
  { message?: string }
> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : "插件页面渲染失败。",
    };
  }

  override render() {
    return (
      <section className="plugin-page-frame" aria-label={this.props.label}>
        {this.state.message ? (
          <div className="workspace-loading" role="alert">
            {this.props.label}无法打开：{this.state.message}
          </div>
        ) : (
          <PluginPageContent renderPage={this.props.renderPage} />
        )}
      </section>
    );
  }
}

/** Invoke the plugin inside a descendant so the boundary catches its errors. */
function PluginPageContent({
  renderPage,
}: {
  renderPage: () => React.ReactNode;
}) {
  return renderPage();
}
