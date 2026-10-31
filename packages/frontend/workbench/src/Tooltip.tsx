import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";

/** DSH sidebar tooltips wait half a second before showing. */
const DELAY_MS = 500;
const GAP = 8;

type Side = "bottom" | "top" | "right";

/**
 * DSH-style hover tip for icon controls: a dark 13px bubble that appears
 * after a short delay on hover or keyboard focus and flips to the opposite
 * side when it would leave the viewport. The child keeps its own
 * `aria-label`; the tip is linked with `aria-describedby`.
 */
export function Tooltip({
  label,
  side = "bottom",
  children,
}: {
  label: React.ReactNode;
  side?: Side;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const id = useId();

  const show = useCallback((element: HTMLElement, now: boolean) => {
    anchor.current = element;
    window.clearTimeout(timer.current);
    if (now) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const target = anchor.current?.getBoundingClientRect();
    const tip = bubble.current;
    if (!open || !target || !tip) return;
    const box = tip.getBoundingClientRect();
    const fits = {
      bottom: target.bottom + GAP + box.height <= innerHeight,
      top: target.top - GAP - box.height >= 0,
      right: target.right + GAP + box.width <= innerWidth,
    };
    const opposite: Record<Side, Side> = {
      bottom: "top",
      top: "bottom",
      right: "bottom",
    };
    const placed = fits[side] ? side : opposite[side];
    const left =
      placed === "right"
        ? target.right + GAP
        : target.left + target.width / 2 - box.width / 2;
    const top =
      placed === "right"
        ? target.top + target.height / 2 - box.height / 2
        : placed === "bottom"
          ? target.bottom + GAP
          : target.top - GAP - box.height;
    tip.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }, [open, side]);

  const child = React.Children.only(children);
  const props = child.props;
  const trigger = React.cloneElement(child, {
    "aria-describedby": open ? id : props["aria-describedby"],
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (event.pointerType === "mouse") show(event.currentTarget, false);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      // Keyboard focus shows at once; a click focus was just hidden above.
      if (event.currentTarget.matches(":focus-visible"))
        show(event.currentTarget, true);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(event);
      if (event.key === "Escape") hide();
    },
  });
  const host =
    anchor.current?.closest("dialog") ??
    document.querySelector(".aura-root") ??
    document.body;
  return (
    <>
      {trigger}
      {open && label
        ? createPortal(
            <div ref={bubble} id={id} role="tooltip" className="aura-tooltip">
              {label}
            </div>,
            host,
          )
        : null}
    </>
  );
}
