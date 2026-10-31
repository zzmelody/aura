import React, { createContext, useContext } from "react";
import type { AuraPluginResultContext } from "@aura/plugin-ui";
import type { RegisteredResult } from "./pluginHost";

const PluginResults = createContext<readonly RegisteredResult[]>([]);

/** Makes plugin result renderers available to every Run view below it. */
export function PluginResultsProvider({
  results,
  children,
}: {
  results: readonly RegisteredResult[];
  children: React.ReactNode;
}) {
  return React.createElement(
    PluginResults.Provider,
    { value: results },
    children,
  );
}

export function usePluginResults(): readonly RegisteredResult[] {
  return useContext(PluginResults);
}

/**
 * First renderer, in registration order, whose `match` accepts this Run.
 * A throwing `match` counts as no match so one plugin cannot hide others.
 */
export function matchPluginResult(
  results: readonly RegisteredResult[],
  context: Omit<AuraPluginResultContext, "pluginId">,
): { result: RegisteredResult; context: AuraPluginResultContext } | undefined {
  for (const result of results) {
    const full = { ...context, pluginId: result.pluginId };
    try {
      if (result.definition.match(full)) return { result, context: full };
    } catch {
      // Ignore and keep looking; the generic view remains available.
    }
  }
  return undefined;
}

/** Renders a plugin result; a render error falls back to the generic view. */
export class PluginResultBoundary extends React.Component<
  { render: () => React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed
      ? this.props.fallback
      : React.createElement(PluginResultContent, { render: this.props.render });
  }
}

/** Invoke the plugin inside a descendant so the boundary catches its errors. */
function PluginResultContent({ render }: { render: () => React.ReactNode }) {
  return render();
}
