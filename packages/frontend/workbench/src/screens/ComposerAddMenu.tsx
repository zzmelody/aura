import React, { useEffect, useId, useRef, useState } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { FlowIcon } from "../FlowIcon";

/**
 * Codex-style "+" in the composer: one entry point for attaching images and
 * calling a workflow, instead of a row of separate icon buttons.
 */
export function ComposerAddMenu({
  canAttach,
  attachFull,
  canInvoke,
  pickerOpen,
  onAttach,
  onWorkflow,
}: {
  canAttach: boolean;
  /** The message already holds the maximum number of images. */
  attachFull: boolean;
  canInvoke: boolean;
  pickerOpen: boolean;
  onAttach(): void;
  onWorkflow(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    root.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  if (!canAttach && !canInvoke) return null;
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="composer-add" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`composer-flow-button${open || pickerOpen ? " open" : ""}`}
        aria-label="添加"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="添加图片或调用工作流"
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={17} />
      </button>
      {open ? (
        <div
          id={menuId}
          className="composer-add-menu"
          role="menu"
          aria-label="添加"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                '[role="menuitem"]:not(:disabled)',
              ) ?? [],
            );
            const index = items.indexOf(document.activeElement as HTMLElement);
            items[
              (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length
            ]?.focus();
          }}
        >
          {canAttach ? (
            <button
              type="button"
              role="menuitem"
              className="composer-add-item"
              disabled={attachFull}
              onClick={() => choose(onAttach)}
            >
              <ImagePlus size={16} aria-hidden="true" />
              <span>
                添加图片
                <small>{attachFull ? "已达上限" : "也可直接粘贴或拖入"}</small>
              </span>
            </button>
          ) : null}
          {canInvoke ? (
            <button
              type="button"
              role="menuitem"
              className="composer-add-item"
              onClick={() => choose(onWorkflow)}
            >
              <FlowIcon size={16} aria-hidden="true" />
              <span>
                调用工作流
                <small>或在输入框键入 /</small>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
