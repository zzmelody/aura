import { startDesktopStartup } from "./startup.ts";

// Keep the host identity even if preload fails; preserve its bridge when present.
window.auraHost ??= { platform: "desktop" };

const startup = startDesktopStartup();
// Keep React and the workbench out of the small, immediately animated entry.
void import("./workbench-root.tsx")
  .then(({ mountWorkbench }) => mountWorkbench(startup))
  .catch(() => startup.fail());

if (import.meta.hot) import.meta.hot.dispose(() => startup.dispose());
