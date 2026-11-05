import { childStartup } from "./startup-timing.ts";

// Runs before DSH's dependency graph is imported, including in Electron's Node.
childStartup?.start("process-bootstrap")();
export const finishDshLoad = childStartup?.start("dsh-load");
