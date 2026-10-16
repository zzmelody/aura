export const MIN_CONVERSATION_WIDTH = 320;
export const CONVERSATION_DIVIDER_WIDTH = 8;
export const DEFAULT_SIDE_WIDTH = 440;

/** Bounds reserve room for both conversations and the divider itself. */
export function conversationSplit(containerWidth: number, preferred?: number) {
  const available = Math.max(
    0,
    Math.floor(containerWidth - CONVERSATION_DIVIDER_WIDTH),
  );
  const min = Math.min(MIN_CONVERSATION_WIDTH, Math.floor(available / 2));
  const max = available - min;
  const requested =
    preferred !== undefined && Number.isFinite(preferred)
      ? preferred
      : Math.min(DEFAULT_SIDE_WIDTH, available * 0.45);
  return {
    min,
    max,
    width: Math.round(Math.max(min, Math.min(max, requested))),
    stacked:
      containerWidth < MIN_CONVERSATION_WIDTH * 2 + CONVERSATION_DIVIDER_WIDTH,
  };
}
