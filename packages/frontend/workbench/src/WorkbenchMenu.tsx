import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Tooltip } from "./Tooltip";

export type WorkbenchMenuItem =
  | {
      id: string;
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Radio-style item: shows a trailing check when the item is current. */
      selected?: boolean;
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
  tooltip,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  items: WorkbenchMenuItem[];
  className?: string;
  title?: string;
  /** DSH hover tip in place of the native `title`. */
  tooltip?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = menu.current;
    if (!open || !button || !panel) return;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
      panel.style.top = `${Math.max(
        8,
        Math.min(
          anchor.bottom + bounds.height + 8 > innerHeight
            ? anchor.top - bounds.height - 5
            : anchor.bottom + 5,
          innerHeight - bounds.height - 8,
        ),
      )}px`;
    };
    position();
    panel
      .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
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
    const observer = new ResizeObserver(position);
    observer.observe(button);
    observer.observe(panel);
    const owner = button.closest(".workspace-main, .workspace-sidebar");
    if (owner) observer.observe(owner);
    document.addEventListener("pointerdown", away);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const triggerButton = (
    <button
      ref={trigger}
      type="button"
      disabled={disabled}
      className={`${className}${open ? " menu-open" : ""}`}
      aria-label={label}
      title={tooltip ? undefined : (title ?? label)}
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
  );
  const portal =
    trigger.current?.closest("dialog") ??
    document.querySelector(".aura-root") ??
    document.body;
  return (
    <>
      {tooltip ? (
        <Tooltip label={open ? "" : tooltip}>{triggerButton}</Tooltip>
      ) : (
        triggerButton
      )}
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
                    role={
                      item.selected === undefined ? "menuitem" : "menuitemradio"
                    }
                    aria-checked={item.selected}
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
                    {item.selected ? (
                      <Check
                        className="workbench-menu-check"
                        size={14}
                        aria-hidden="true"
                      />
                    ) : null}
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
