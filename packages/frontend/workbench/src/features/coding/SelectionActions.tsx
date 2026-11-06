import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { selectionQuote } from "./selection-quote";
import { useConversationMessages } from "../../conversation-messages";

export interface SelectionAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  /** Receives the selection already formatted as a Markdown quote. */
  run(quote: string): void;
}

interface TranscriptSelection {
  text: string;
  rect: DOMRect;
}

/** Reads a non-empty selection that lies inside a transcript within `root`. */
function transcriptSelection(root: HTMLElement): TranscriptSelection | null {
  const current = window.getSelection();
  if (!current || current.isCollapsed || !current.rangeCount) return null;
  const range = current.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const transcript = element?.closest(".coding-transcript");
  if (!transcript || !root.contains(transcript)) return null;
  const text = current.toString();
  if (!text.trim()) return null;
  return { text, rect: range.getBoundingClientRect() };
}

/** A floating toolbar over selected transcript text, like Codex's "add to chat". */
export function SelectionActions({
  root,
  actions,
}: {
  root: React.RefObject<HTMLElement | null>;
  actions: SelectionAction[];
}) {
  const { t } = useConversationMessages();
  const popup = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Read after the browser settles the selection, e.g. a click that collapses it.
    const show = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        setSelection(root.current ? transcriptSelection(root.current) : null);
      }, 0);
    };
    // Hide eagerly, but only show once the drag or key press ends.
    const update = () => {
      if (!root.current || !transcriptSelection(root.current))
        setSelection(null);
    };
    const hide = () => setSelection(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerup", show);
    document.addEventListener("keyup", show);
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerup", show);
      document.removeEventListener("keyup", show);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [root]);

  useLayoutEffect(() => {
    const node = popup.current;
    if (!selection || !node) return;
    node.showPopover();
    return () => node.hidePopover();
  }, [selection]);

  useLayoutEffect(() => {
    const node = popup.current;
    if (!selection || !node) return;
    const position = () => {
      const margin = 8;
      const gap = 8;
      const { rect } = selection;
      const bounds = node.getBoundingClientRect();
      const above = rect.top - gap - bounds.height;
      const top =
        above >= margin
          ? above
          : Math.min(
              rect.bottom + gap,
              window.innerHeight - bounds.height - margin,
            );
      const left = Math.max(
        margin,
        Math.min(
          rect.left + rect.width / 2 - bounds.width / 2,
          window.innerWidth - bounds.width - margin,
        ),
      );
      node.style.top = `${top}px`;
      node.style.left = `${left}px`;
    };
    position();
    // Translated action labels can change the size without changing selection.
    const observer = new ResizeObserver(position);
    observer.observe(node);
    return () => observer.disconnect();
  }, [actions, selection]);

  if (!selection) return null;
  return (
    <div
      ref={popup}
      popover="manual"
      className="selection-actions"
      role="toolbar"
      aria-label={t("selectionActions")}
      // Keep the transcript selection while pressing a button.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="selection-action"
          disabled={action.disabled}
          onClick={() => {
            const quote = selectionQuote(selection.text);
            setSelection(null);
            window.getSelection()?.removeAllRanges();
            if (quote) action.run(quote);
          }}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  );
}
