import { paneSplit, type SplitBounds } from "../../pane-split.ts";

export const MIN_CONVERSATION_WIDTH = 320;
export const CONVERSATION_DIVIDER_WIDTH = 8;
export const DEFAULT_SIDE_WIDTH = 440;

export const CONVERSATION_BOUNDS: SplitBounds = {
  side: MIN_CONVERSATION_WIDTH,
  main: MIN_CONVERSATION_WIDTH,
  divider: CONVERSATION_DIVIDER_WIDTH,
  preferred: DEFAULT_SIDE_WIDTH,
  share: 0.45,
};

/** Bounds reserve room for both conversations and the divider itself. */
export function conversationSplit(containerWidth: number, preferred?: number) {
  return paneSplit(containerWidth, preferred, CONVERSATION_BOUNDS);
}
