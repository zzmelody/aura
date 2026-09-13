import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  wheelGestureMode,
  zoomFlowViewport,
  type FlowViewport,
  type Point,
} from "./flowViewport";

export function useFlowViewport(
  canvas: RefObject<HTMLDivElement | null>,
  fit: number,
  source: string,
  enabled: boolean,
) {
  const [view, setView] = useState<FlowViewport>({
    zoom: fit,
    pan: { x: 0, y: 0 },
  });
  const current = useRef(view);
  const automatic = useRef(true);
  const frame = useRef<number | undefined>(undefined);
  const wheel = useRef<{ mode: "zoom" | "pan"; at: number } | undefined>(
    undefined,
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const commit = useCallback((next: FlowViewport) => {
    automatic.current = false;
    current.current = next;
    if (frame.current === undefined)
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        setView(current.current);
      });
  }, []);
  const reset = useCallback(() => {
    automatic.current = true;
    current.current = { zoom: fitRef.current, pan: { x: 0, y: 0 } };
    setView(current.current);
  }, []);
  useEffect(reset, [source, reset]);
  useEffect(() => {
    if (automatic.current) reset();
  }, [fit, reset]);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const anchor = useCallback(
    (point: Point) => {
      const rect = canvas.current!.getBoundingClientRect();
      return {
        x: point.x - rect.left - rect.width / 2,
        y: point.y - rect.top - rect.height / 2,
      };
    },
    [canvas],
  );
  useEffect(() => {
    const element = canvas.current;
    if (!element || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      // This listener is local and non-passive so canvas gestures never zoom the page.
      event.preventDefault();
      const now = performance.now();
      let mode: "zoom" | "pan";
      if (event.ctrlKey || event.metaKey) mode = "zoom";
      else if (event.shiftKey) mode = "pan";
      else {
        mode =
          wheel.current && now - wheel.current.at < 180
            ? wheel.current.mode
            : wheelGestureMode(event);
        wheel.current = { mode, at: now };
      }
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      if (mode === "pan")
        commit({
          ...current.current,
          pan: {
            x: current.current.pan.x - event.deltaX * unit,
            y: current.current.pan.y - event.deltaY * unit,
          },
        });
      else
        commit(
          zoomFlowViewport(
            current.current,
            current.current.zoom *
              Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.002)),
            anchor({ x: event.clientX, y: event.clientY }),
          ),
        );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [canvas, enabled, commit, anchor]);
  return { view, current, commit, reset, anchor };
}
