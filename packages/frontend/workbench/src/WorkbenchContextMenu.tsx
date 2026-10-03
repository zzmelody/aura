import React, { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { WorkbenchMenuItem } from "./WorkbenchMenu";

/**
 * Right-click menu anchored at the pointer. Shares item styling and keyboard
 * behaviour with WorkbenchMenu, but has no trigger button of its own.
 */
export function WorkbenchContextMenu({
  label,
  items,
  at,
  onClose,
}: {
  label: string;
  items: WorkbenchMenuItem[];
  /** Viewport coordinates of the opening click. */
  at: { x: number; y: number };
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(at.x, innerWidth - box.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(at.y, innerHeight - box.height - 8))}px`;
    panel.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const away = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [at, onClose]);
  const portal = document.querySelector(".aura-root") ?? document.body;
  return createPortal(
    <div
      ref={menu}
      className="workbench-menu"
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const entries = Array.from(
          menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
        );
        const index = entries.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? entries.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
                entries.length;
        entries[next]?.focus();
      }}
    >
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.id} className="workbench-menu-divider" role="separator" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            className={`workbench-menu-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        ),
      )}
    </div>,
    portal,
  );
}
