import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useSidebarMessages } from "./sidebar-messages";

export const DEFAULT_SIDEBAR_WIDTH = 280;

/** Keep pointer movement out of workspace state; persist only the committed width. */
export function ResizableSidebar({
  collapsed,
  width,
  viewport,
  onResize,
  children,
}: {
  collapsed: boolean;
  width: number;
  viewport: number;
  onResize(width: number): void;
  children: React.ReactNode;
}) {
  const { t, i18n } = useSidebarMessages();
  const min = 240;
  const max = Math.min(480, Math.max(min, viewport - 560));
  const actual = Math.round(Math.max(min, Math.min(max, width)));
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startX: number;
    initial: number;
    current: number;
  } | null>(null);
  const frame = useRef(0);
  const paint = (value: number) => {
    root.current?.style.setProperty("--sidebar-width", `${value}px`);
    handle.current?.setAttribute("aria-valuenow", String(value));
    handle.current?.setAttribute(
      "aria-valuetext",
      // A queued frame may run after the locale changed.
      i18n.t("sidebarWidthValue", { ns: "sidebar", width: value }),
    );
  };
  useLayoutEffect(() => {
    // A language render must describe the in-progress drag, not the saved width.
    handle.current?.setAttribute(
      "aria-valuetext",
      t("sidebarWidthValue", { width: drag.current?.current ?? actual }),
    );
  }, [actual, t]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
    },
    [],
  );
  const finish = (cancel = false) => {
    if (!drag.current) return;
    cancelAnimationFrame(frame.current);
    const value = cancel ? drag.current.initial : drag.current.current;
    drag.current = null;
    root.current?.removeAttribute("data-resizing");
    paint(value);
    if (!cancel) onResize(value);
  };
  return (
    <div
      ref={root}
      className="resizable-sidebar"
      inert={collapsed}
      style={{ "--sidebar-width": `${actual}px` } as React.CSSProperties}
    >
      {children}
      <div
        ref={handle}
        className="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={t("resizeSidebar")}
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={actual}
        aria-valuetext={t("sidebarWidthValue", { width: actual })}
        title={t("resizeHint")}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            startX: event.clientX,
            initial: actual,
            current: actual,
          };
          root.current?.setAttribute("data-resizing", "true");
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.current = Math.round(
            Math.max(
              min,
              Math.min(
                max,
                drag.current.initial + event.clientX - drag.current.startX,
              ),
            ),
          );
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            if (drag.current) paint(drag.current.current);
          });
        }}
        onPointerUp={(event) => {
          finish();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish()}
        onDoubleClick={() => onResize(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : actual + (event.key === "ArrowRight" ? 16 : -16);
          onResize(Math.max(min, Math.min(max, next)));
        }}
      />
    </div>
  );
}
