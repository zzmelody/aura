import type React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { paneSplit, type SplitBounds } from "./pane-split.ts";

function savedWidth(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
    return undefined;
  }
}

/**
 * Measure the split's container, before paint, through a callback ref. A
 * layout effect would observe only the node present on its first run, so a
 * container mounted later — behind a Suspense fallback, or a `hidden` deck
 * revealed by a tab change — would stay reported as 0 forever. The callback
 * re-attaches on every mount, and `width` stays 0 only while genuinely
 * unmeasured, so callers can fall back instead of collapsing a pane.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) {
      observer.current = null;
      return;
    }
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);
  return { ref, width };
}

export interface PaneSplitLabels {
  label: string;
  hint: string;
  valueText(width: number): string;
}

/**
 * One bounded, keyboard-accessible pane divider. A drag only previews the
 * width, so resizing never remounts either pane, and just the finished gesture
 * is persisted. Passing `active: false` cancels an in-flight drag.
 */
export function usePaneSplit({
  storageKey,
  bounds,
  containerWidth,
  active,
  labels,
}: {
  storageKey: string;
  bounds: SplitBounds;
  containerWidth: number;
  /** The divider is reachable: its pane is visible and not covered. */
  active: boolean;
  labels: PaneSplitLabels;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    initial: number;
    current: number;
    preferred: number | undefined;
  } | null>(null);
  const [preferred, setPreferred] = useState(() => savedWidth(storageKey));
  const [resizing, setResizing] = useState(false);
  // An unmeasured container must not report the stacked layout before paint.
  const { min, max, width, stacked } = paneSplit(
    containerWidth || 1000,
    preferred,
    bounds,
  );
  const commit = useCallback(
    (value?: number) => {
      setPreferred(value);
      try {
        if (value === undefined) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(value));
      } catch {
        // Resizing still works for this mount when persistence is blocked.
      }
    },
    [storageKey],
  );
  const finish = useCallback(
    (cancel = false) => {
      if (!drag.current) return;
      const { current, preferred: initialPreferred } = drag.current;
      drag.current = null;
      setResizing(false);
      if (cancel) setPreferred(initialPreferred);
      else commit(current);
    },
    [commit],
  );
  // A divider that stacks away or becomes unreachable abandons its drag.
  useLayoutEffect(() => {
    if (!active || stacked) finish(true);
  }, [active, finish, stacked]);
  const handle: React.ComponentPropsWithoutRef<"div"> = {
    role: "separator",
    tabIndex: 0,
    "aria-label": labels.label,
    "aria-orientation": "vertical",
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": width,
    "aria-valuetext": labels.valueText(width),
    title: labels.hint,
    onPointerDown(event) {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        initial: width,
        current: width,
        preferred,
      };
      setResizing(true);
    },
    onPointerMove(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      const next = paneSplit(
        containerWidth,
        drag.current.initial - (event.clientX - drag.current.startX),
        bounds,
      ).width;
      drag.current.current = next;
      setPreferred(next);
    },
    onPointerUp(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      finish();
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel(event) {
      if (drag.current?.pointerId === event.pointerId) finish(true);
    },
    onLostPointerCapture(event) {
      if (drag.current?.pointerId === event.pointerId) finish();
    },
    onDoubleClick: () => commit(),
    onKeyDown(event) {
      if (event.key === "Escape" && drag.current) {
        const { pointerId } = drag.current;
        event.preventDefault();
        finish(true);
        if (event.currentTarget.hasPointerCapture(pointerId))
          event.currentTarget.releasePointerCapture(pointerId);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : width + (event.key === "ArrowLeft" ? 16 : -16);
      commit(paneSplit(containerWidth, next, bounds).width);
    },
  };
  return { min, max, width, stacked, resizing, handle };
}
