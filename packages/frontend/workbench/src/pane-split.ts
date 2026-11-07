/** Pixel bounds of a draggable split: both panes stay usable at every width. */
export interface SplitBounds {
  /** Smallest usable width for the pane the divider resizes. */
  side: number;
  /** Smallest usable width the remaining pane keeps. */
  main: number;
  /** Width the divider itself occupies between the panes. */
  divider: number;
  /** Side width when nothing is saved, capped at `share` of the free space. */
  preferred: number;
  share: number;
}

/** Bounds reserve room for both panes and the divider itself. */
export function paneSplit(
  containerWidth: number,
  preferred: number | undefined,
  bounds: SplitBounds,
) {
  const available = Math.max(0, Math.floor(containerWidth - bounds.divider));
  // Below the stacking breakpoint neither minimum fits, so both shrink in
  // proportion rather than letting one pane take the whole shortfall.
  const total = bounds.side + bounds.main;
  const scale = total <= available ? 1 : available / total;
  const min = Math.floor(bounds.side * scale);
  const max = Math.max(min, available - Math.floor(bounds.main * scale));
  const requested =
    preferred !== undefined && Number.isFinite(preferred)
      ? preferred
      : Math.min(bounds.preferred, available * bounds.share);
  return {
    min,
    max,
    width: Math.round(Math.max(min, Math.min(max, requested))),
    stacked: containerWidth < bounds.side + bounds.main + bounds.divider,
  };
}
