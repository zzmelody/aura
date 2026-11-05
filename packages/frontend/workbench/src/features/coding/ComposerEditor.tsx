import React, { useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, RefObject } from "react";
import { commandDeletionRange, type DraftRange } from "./composer-commands";

export function ComposerEditor({
  editor,
  value,
  command,
  references,
  onBlur,
  onClick,
  onKeyDown,
  onSelect,
  ...props
}: ComponentPropsWithoutRef<"textarea"> & {
  editor: RefObject<HTMLTextAreaElement | null>;
  value: string;
  command?: DraftRange;
  references: DraftRange[];
}) {
  const highlights = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    value: string;
    caret: number;
    key: string;
  }>();
  const selected = selection?.value === value ? selection : undefined;
  const ranges = command ? [command, ...references] : references;

  useLayoutEffect(() => {
    const input = editor.current;
    if (!input) return;
    const fit = () => {
      if (!input.clientWidth) {
        input.style.height = "";
        return;
      }
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
      const layer = highlights.current;
      if (layer) {
        layer.style.width = `${input.clientWidth}px`;
        layer.scrollTop = input.scrollTop;
      }
    };
    fit();
    // Side panes can first measure while still sliding open.
    let width = input.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (input.offsetWidth === width) return;
      width = input.offsetWidth;
      fit();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [editor, value, ranges.length]);

  return (
    <div className="coding-composer-editor">
      {ranges.length > 0 && (
        <div
          ref={highlights}
          className="coding-composer-highlights"
          aria-hidden="true"
        >
          {ranges.map(({ start, end }, index) => (
            <React.Fragment key={start}>
              {value.slice(ranges[index - 1]?.end ?? 0, start)}
              <mark
                data-command={start === command?.start ? "" : undefined}
                data-selected={
                  start === command?.start && selected ? "" : undefined
                }
              >
                {value.slice(start, end)}
              </mark>
            </React.Fragment>
          ))}
          {value.slice(ranges.at(-1)?.end)}
          {"\n"}
        </div>
      )}
      <textarea
        {...props}
        ref={editor}
        value={value}
        onBlur={(event) => {
          setSelection(undefined);
          onBlur?.(event);
        }}
        onClick={(event) => {
          setSelection(undefined);
          onClick?.(event);
        }}
        onSelect={(event) => {
          const input = event.currentTarget;
          if (
            selected &&
            (input.selectionStart !== selected.caret ||
              input.selectionEnd !== selected.caret)
          )
            setSelection(undefined);
          onSelect?.(event);
        }}
        onKeyDown={(event) => {
          const { key, currentTarget: input } = event;
          const caret = input.selectionStart;
          if (
            command &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229 &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            if (key === "Backspace" || key === "Delete") {
              const range = commandDeletionRange(
                value,
                command,
                { start: caret, end: input.selectionEnd },
                key === "Backspace",
              );
              if (range) {
                if (selected?.caret === caret && selected.key === key) {
                  setSelection(undefined);
                  // Let the textarea delete the range as one native undo step.
                  input.setSelectionRange(range.start, range.end);
                } else {
                  event.preventDefault();
                  setSelection({ value, caret, key });
                }
                return;
              }
            } else if (!event.shiftKey && caret === input.selectionEnd) {
              const edge =
                key === "ArrowLeft" &&
                caret > command.start &&
                caret <= command.end
                  ? command.start
                  : key === "ArrowRight" &&
                      caret >= command.start &&
                      caret < command.end
                    ? command.end
                    : undefined;
              if (edge !== undefined) {
                event.preventDefault();
                setSelection(undefined);
                input.setSelectionRange(edge, edge);
                return;
              }
            }
          }
          setSelection(undefined);
          onKeyDown?.(event);
        }}
        onScroll={(event) => {
          if (highlights.current)
            highlights.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
