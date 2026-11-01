import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@aura/workbench";
import type { DesktopStartup } from "./startup.ts";

/** The host removes its startup surface only after the first screen commits. */
export function mountWorkbench(startup: DesktopStartup): void {
  const element = document.getElementById("root");
  if (!element) throw new Error("Aura root element is missing.");
  const root = createRoot(element, { onUncaughtError: () => startup.fail() });
  root.render(
    <StrictMode>
      <App onReady={startup.ready} />
    </StrictMode>,
  );
  if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
}
