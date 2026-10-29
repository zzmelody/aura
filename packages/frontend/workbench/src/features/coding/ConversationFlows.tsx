import React, { useEffect, useRef, useState } from "react";
import type { FlowCatalogEntry } from "@aura/protocol/types";
import { FlowIcon } from "../../FlowIcon";
import { filterFlows } from "../../flowPicker";
import { FlowPicker } from "../../screens/FlowPicker";

/** Explicit workflow selection opens the existing schema-driven run form. */
export function ConversationFlows({
  flows,
  query,
  loading,
  onPick,
  onClose,
  keyboardActive,
  onKeyboardActive,
}: {
  flows: FlowCatalogEntry[];
  query?: string;
  loading: boolean;
  onPick(flow: FlowCatalogEntry): void;
  onClose(): void;
  keyboardActive: number;
  onKeyboardActive(index: number): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = open || query !== undefined;
  useEffect(() => {
    if (!visible) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        onClose();
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [visible, onClose]);
  return (
    <div className="composer-add" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="icon-control"
        aria-label="调用工作流"
        aria-expanded={open || query !== undefined}
        onClick={() => setOpen(!open)}
      >
        <FlowIcon size={16} />
      </button>
      {open || query !== undefined ? (
        <FlowPicker
          anchor={trigger}
          flows={filterFlows(flows, query ?? search)}
          query={query ?? search}
          active={query === undefined ? active : keyboardActive}
          loading={loading}
          searchable={query === undefined}
          onQuery={(value) => {
            setSearch(value);
            setActive(0);
          }}
          onActive={query === undefined ? setActive : onKeyboardActive}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          onPick={(flow) => {
            setOpen(false);
            onClose();
            onPick(flow);
          }}
        />
      ) : null}
    </div>
  );
}
