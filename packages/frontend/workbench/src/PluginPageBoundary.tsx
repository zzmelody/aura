import React from "react";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import { pluginMessage, usePluginMessages } from "./plugin-messages";

/** Isolates a plugin page so a render error cannot unmount the workbench. */
export class PluginPageBoundary extends React.Component<
  { label: string; renderPage: () => React.ReactNode },
  { message?: string | MessageReference }
> {
  state: { message?: string | MessageReference } = {};

  static getDerivedStateFromError(error: unknown) {
    return {
      message: errorMessage(error, pluginMessage("renderFailed")),
    };
  }

  override render() {
    return (
      <section className="plugin-page-frame" aria-label={this.props.label}>
        {this.state.message !== undefined ? (
          <PluginPageFailure
            label={this.props.label}
            message={this.state.message}
          />
        ) : (
          <PluginPageContent renderPage={this.props.renderPage} />
        )}
      </section>
    );
  }
}

function PluginPageFailure({
  label,
  message,
}: {
  label: string;
  message: string | MessageReference;
}) {
  const { t, i18n } = usePluginMessages();
  return (
    <div className="workspace-loading" role="alert">
      {t("pageOpenFailed", { label, message: messageText(message, i18n) })}
    </div>
  );
}

/** Invoke the plugin inside a descendant so the boundary catches its errors. */
function PluginPageContent({
  renderPage,
}: {
  renderPage: () => React.ReactNode;
}) {
  return renderPage();
}
