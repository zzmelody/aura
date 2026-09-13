export type Point = { x: number; y: number };
export type FlowViewport = { zoom: number; pan: Point };
export const MIN_GRAPH_ZOOM = 0.1;
export const MAX_GRAPH_ZOOM = 3;

/** Anchors are measured from the center of the viewport in screen pixels. */
export function zoomFlowViewport(
  view: FlowViewport,
  zoom: number,
  anchor: Point,
  destination = anchor,
): FlowViewport {
  const next = Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, zoom));
  const ratio = next / view.zoom;
  return {
    zoom: next,
    pan: {
      x: destination.x - (anchor.x - view.pan.x) * ratio,
      y: destination.y - (anchor.y - view.pan.y) * ratio,
    },
  };
}

/** WheelEvent has no device identity. Latch this hint for a whole scroll gesture. */
export function wheelGestureMode(event: {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}): "zoom" | "pan" {
  return event.deltaMode !== 0 ||
    (event.deltaX === 0 &&
      Math.abs(event.deltaY - Math.round(event.deltaY)) < 0.01 &&
      Math.abs(event.deltaY) >= 40)
    ? "zoom"
    : "pan";
}
