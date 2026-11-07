import type { SplitBounds } from "./pane-split.ts";

export const WORKFLOW_SPLIT_STORAGE_KEY = "aura.workflow.assistant-width";

/**
 * The diagram canvas needs more room than the assistant beside it, so the main
 * pane keeps a larger minimum. The divider matches the conversation split's
 * grip width so both dividers feel the same.
 */
export const WORKFLOW_SPLIT_BOUNDS: SplitBounds = {
  side: 320,
  main: 360,
  divider: 8,
  preferred: 400,
  share: 0.34,
};
