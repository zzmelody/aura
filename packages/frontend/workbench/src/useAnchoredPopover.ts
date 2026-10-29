import { useLayoutEffect, type RefObject } from "react";

/** A bounded top-layer popup that retains its anchor's theme and escapes clipping. */
export function useAnchoredPopover(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const popup = menu.current;
    const button = trigger.current;
    if (!open || !popup || !button) return;
    popup.showPopover();
    const position = () => {
      const rect = button.getBoundingClientRect();
      const margin = 8;
      const gap = 10;
      const above = Math.max(0, rect.top - gap - margin);
      const below = Math.max(
        0,
        window.innerHeight - rect.bottom - gap - margin,
      );
      const upwards =
        above >= Math.min(440, window.innerHeight * 0.6) || above >= below;
      popup.style.maxHeight = `${Math.min(440, upwards ? above : below)}px`;
      const bounds = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(margin, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - margin))}px`;
      popup.style.top = `${upwards ? rect.top - gap - bounds.height : rect.bottom + gap}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(button);
    observer.observe(popup);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      popup.hidePopover();
    };
  }, [open, menu, trigger]);
}
