import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { conversationSplit } from "./split-layout";
import { useToolMessages } from "../../tool-messages";

const STORAGE_KEY = "aura.coding.side-width";

function savedWidth(): number | undefined {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
    return undefined;
  }
}

/** A bounded, keyboard-accessible split; resizing never remounts either chat. */
export function ConversationSplit({
  main,
  side,
  sideVisible = !!side,
  hidden = false,
  mainHeader,
  sideHeader,
}: {
  main: React.ReactNode;
  side?: React.ReactNode;
  /** Hidden side chats stay mounted without reserving width or a divider. */
  sideVisible?: boolean;
  /** Another view covers the panes; they stay mounted so streams continue. */
  hidden?: boolean;
  mainHeader?: React.ReactNode;
  sideHeader?: React.ReactNode;
}) {
  const { t } = useToolMessages();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    initial: number;
    current: number;
    preferred: number | undefined;
  } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [preferred, setPreferred] = useState(savedWidth);
  const { min, max, width, stacked } = conversationSplit(
    containerWidth || 1000,
    preferred,
  );
  // Measure before paint so a saved width never flashes wider than the space.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setContainerWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const commit = useCallback((value?: number) => {
    setPreferred(value);
    try {
      if (value === undefined) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Resizing still works for this mount when persistence is blocked.
    }
  }, []);
  const finish = useCallback(
    (cancel = false) => {
      if (!drag.current) return;
      const { current, preferred: initialPreferred } = drag.current;
      drag.current = null;
      root.current?.removeAttribute("data-resizing");
      if (cancel) setPreferred(initialPreferred);
      else commit(current);
    },
    [commit],
  );
  useLayoutEffect(() => {
    if (!sideVisible || stacked || hidden) finish(true);
  }, [finish, hidden, sideVisible, stacked]);
  return (
    <div
      ref={root}
      className="coding-panes"
      hidden={hidden}
      data-stacked={stacked || undefined}
      data-tools-only={(sideVisible && stacked && !!sideHeader) || undefined}
      data-side-closed={!sideVisible || undefined}
      style={
        {
          "--coding-side-width": `${containerWidth ? width : 0}px`,
        } as React.CSSProperties
      }
    >
      {mainHeader ? (
        <div
          className="coding-pane coding-main-column"
          inert={sideVisible && stacked && !!sideHeader}
        >
          {mainHeader}
          {main}
        </div>
      ) : (
        main
      )}
      {side ? (
        <>
          {!stacked ? (
            <div
              className="coding-split-handle"
              inert={!sideVisible}
              role="separator"
              tabIndex={0}
              aria-label={t("resizeConversationSplit")}
              aria-orientation="vertical"
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={width}
              aria-valuetext={t("toolPanelWidth", { width })}
              title={t("resizeHint")}
              onPointerDown={(event) => {
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
                root.current?.setAttribute("data-resizing", "true");
              }}
              onPointerMove={(event) => {
                if (drag.current?.pointerId !== event.pointerId) return;
                const next = conversationSplit(
                  containerWidth,
                  drag.current.initial - (event.clientX - drag.current.startX),
                ).width;
                drag.current.current = next;
                setPreferred(next);
              }}
              onPointerUp={(event) => {
                if (drag.current?.pointerId !== event.pointerId) return;
                finish();
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                if (drag.current?.pointerId === event.pointerId) finish(true);
              }}
              onLostPointerCapture={(event) => {
                if (drag.current?.pointerId === event.pointerId) finish();
              }}
              onDoubleClick={() => commit()}
              onKeyDown={(event) => {
                if (event.key === "Escape" && drag.current) {
                  const { pointerId } = drag.current;
                  event.preventDefault();
                  finish(true);
                  if (event.currentTarget.hasPointerCapture(pointerId))
                    event.currentTarget.releasePointerCapture(pointerId);
                  return;
                }
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? min
                    : event.key === "End"
                      ? max
                      : width + (event.key === "ArrowLeft" ? 16 : -16);
                commit(conversationSplit(containerWidth, next).width);
              }}
            />
          ) : null}
          {sideHeader ? (
            <aside
              className="coding-side"
              aria-label={t("toolPanel")}
              inert={!sideVisible}
            >
              {sideHeader}
              {side}
            </aside>
          ) : (
            side
          )}
        </>
      ) : null}
    </div>
  );
}
