import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type WorkbenchMenuItem =
  | {
      id: string;
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      action(): void;
    }
  | { id: string; separator: true };

/** Menus escape scrolling lists, but stay inside a modal drawer's top layer. */
export function WorkbenchMenu({
  label,
  children,
  items,
  className = "icon-control",
  title,
}: {
  label: string;
  children: React.ReactNode;
  items: WorkbenchMenuItem[];
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const button = trigger.current.getBoundingClientRect();
    const panel = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(button.left, innerWidth - panel.width - 8))}px`;
    menu.current.style.top = `${Math.max(
      8,
      button.bottom + panel.height + 8 > innerHeight
        ? button.top - panel.height - 5
        : button.bottom + 5,
    )}px`;
    menu.current
      .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const away = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const portal =
    trigger.current?.closest("dialog") ??
    document.querySelector(".aura-root") ??
    document.body;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${className}${open ? " menu-open" : ""}`}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              id={id}
              className="workbench-menu"
              role="menu"
              aria-label={label}
              onBlur={(event) => {
                if (
                  event.relatedTarget &&
                  !event.currentTarget.contains(event.relatedTarget as Node) &&
                  !trigger.current?.contains(event.relatedTarget as Node)
                )
                  setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  close();
                  return;
                }
                const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const entries = Array.from(
                  menu.current?.querySelectorAll<HTMLElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ) ?? [],
                );
                const at = entries.indexOf(
                  document.activeElement as HTMLElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? entries.length - 1
                      : (at +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          entries.length) %
                        entries.length;
                entries[next]?.focus();
              }}
            >
              {items.map((item) =>
                "separator" in item ? (
                  <div
                    key={item.id}
                    className="workbench-menu-divider"
                    role="separator"
                  />
                ) : (
                  <button
                    key={item.id}
                    role="menuitem"
                    type="button"
                    disabled={item.disabled}
                    className={`workbench-menu-item${item.danger ? " danger" : ""}`}
                    onClick={() => {
                      close();
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
          )
        : null}
    </>
  );
}
