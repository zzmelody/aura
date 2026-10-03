import React, { useEffect, useId, useRef } from "react";
import { GitBranch, Search } from "lucide-react";
import type { FlowCatalogEntry } from "@aura/protocol/types";

/** Searchable popover above the composer; the textarea keeps keyboard focus. */
export function FlowPicker({
  flows,
  query,
  active,
  loading,
  searchable,
  onQuery,
  onActive,
  onPick,
  onClose,
}: {
  flows: FlowCatalogEntry[];
  query: string;
  active: number;
  loading: boolean;
  /** False while the query is typed after "/" in the composer itself. */
  searchable: boolean;
  onQuery(query: string): void;
  onActive(index: number): void;
  onPick(flow: FlowCatalogEntry): void;
  onClose(): void;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchable) search.current?.focus();
  }, [searchable]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="flow-picker" role="dialog" aria-label="选择工作流">
      {searchable ? (
        <label className="flow-picker-search">
          <Search size={14} />
          <input
            ref={search}
            aria-label="搜索工作流"
            aria-controls={id}
            aria-activedescendant={
              flows[active] ? `${id}-${active}` : undefined
            }
            placeholder="搜索工作流…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => handlePickerKey(event, flows, active, onActive, onPick, onClose)}
          />
        </label>
      ) : (
        <div className="flow-picker-hint">
          <span>工作流</span>
          <kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 确认 <kbd>Esc</kbd> 关闭
        </div>
      )}
      <div className="flow-picker-list" role="listbox" id={id} ref={list}>
        {flows.map((flow, index) => (
          <button
            key={flow.id}
            id={`${id}-${index}`}
            type="button"
            role="option"
            data-index={index}
            aria-selected={index === active}
            aria-disabled={!flow.available}
            className={`flow-picker-option${index === active ? " active" : ""}`}
            onMouseEnter={() => onActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => flow.available && onPick(flow)}
            title={flow.error}
          >
            <span className="flow-picker-icon">
              <GitBranch size={15} />
            </span>
            <span className="flow-picker-copy">
              <strong>{flow.title}</strong>
              <span>{flow.description || flow.id}</span>
            </span>
            <span
              className={`flow-picker-state${flow.available ? "" : " unavailable"}`}
            >
              {flow.available ? "可运行" : "不可用"}
            </span>
          </button>
        ))}
        {!flows.length ? (
          <p className="flow-picker-empty" role="status">
            {loading ? "正在读取工作流目录…" : "没有匹配的工作流"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Shared by the search field and the composer while "/" is typed. */
export function handlePickerKey(
  event: React.KeyboardEvent,
  flows: FlowCatalogEntry[],
  active: number,
  onActive: (index: number) => void,
  onPick: (flow: FlowCatalogEntry) => void,
  onClose: () => void,
): boolean {
  if (event.nativeEvent.isComposing) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (flows.length)
      onActive(
        (active + (event.key === "ArrowDown" ? 1 : -1) + flows.length) %
          flows.length,
      );
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    const flow = flows[active];
    if (!flow) return false;
    event.preventDefault();
    if (flow.available) onPick(flow);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return true;
  }
  return false;
}
