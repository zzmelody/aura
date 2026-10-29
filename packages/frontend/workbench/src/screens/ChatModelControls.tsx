import { useAnchoredPopover } from "../useAnchoredPopover";
import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RotateCcw } from "lucide-react";
import type {
  ChatModelCatalog,
  ChatModelSelection,
  FlowMode,
} from "@aura/protocol/types";
import { groupModelsByVendor } from "@aura/protocol/models";
import { selectChatModel } from "../chatModels";
import "./chat-model-controls.css";

const effortName = (effort: { id: string; name: string }) =>
  effort.id === "xhigh" ? "Extra High" : effort.name;

/**
 * One compact trigger in the composer row: model name with its reasoning
 * effort, opening a menu. Model metadata belongs to DSH; the browser only
 * renders and stores a choice.
 */
export function ChatModelControls({
  endpoint,
  mode,
  selection,
  disabled,
  onChange,
}: {
  endpoint: string;
  mode: FlowMode;
  selection: ChatModelSelection;
  disabled: boolean;
  onChange(selection: ChatModelSelection): void;
}) {
  const key = `${endpoint}/${mode}`;
  const [result, setResult] = useState<{
    key: string;
    catalog?: ChatModelCatalog;
    error?: string;
  }>();
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useAnchoredPopover(open, trigger, menu);
  useEffect(() => {
    const abort = new AbortController();
    setResult(undefined);
    void fetch(`${endpoint}/chat/models?mode=${mode}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("模型目录暂时不可用");
        return (await response.json()) as ChatModelCatalog;
      })
      .then((catalog) => {
        if (!abort.signal.aborted) setResult({ key, catalog });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setResult({ key, error: "模型目录暂时不可用" });
      });
    return () => abort.abort();
  }, [endpoint, mode, key, revision]);
  // Close on outside pointer, Escape, or when the composer becomes busy.
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
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      )
      ?.focus();
  }, [open]);

  const catalog = result?.key === key ? result.catalog : undefined;
  const error = result?.key === key ? result.error : undefined;
  const modelId = selection.model ?? catalog?.defaultModel;
  const model = catalog?.models.find(({ id }) => id === modelId);
  const effort = selection.reasoningEffort;
  const shownEffort = model?.reasoningEfforts.find(
    ({ id }) => id === (effort ?? model.defaultReasoningEffort),
  );
  const unsupported = Boolean(
    catalog &&
    (!model ||
      (effort && !model.reasoningEfforts.some(({ id }) => id === effort))),
  );
  const label =
    model?.name ?? selection.model ?? (error ? "模型不可用" : "读取模型…");

  /** Arrow keys move between menu items; Home/End jump to the ends. */
  function moveFocus(event: React.KeyboardEvent) {
    const items = Array.from(
      root.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]:not([aria-disabled="true"]), .chat-model-menu-retry',
      ) ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(index - 1 + items.length) % items.length]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <div className="chat-model-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`chat-model-trigger${unsupported ? " warning" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`模型：${label}${shownEffort ? `，思考强度：${effortName(shownEffort)}` : ""}`}
        title={
          unsupported
            ? "已保存的配置不可用，请重新选择"
            : "选择模型和思考强度（仅本会话）"
        }
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chat-model-name">{label}</span>
        {shownEffort ? (
          <span className="chat-model-effort">{effortName(shownEffort)}</span>
        ) : null}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menu}
          popover="manual"
          id={menuId}
          className="chat-model-menu"
          role="menu"
          aria-label="模型与思考强度"
          onKeyDown={moveFocus}
        >
          {catalog ? (
            <>
              <div className="chat-model-menu-heading">模型</div>
              <div
                className="chat-model-menu-list"
                role="group"
                aria-label="模型"
              >
                {(catalog.models.some((entry) => entry.vendor)
                  ? groupModelsByVendor(catalog.models)
                  : [{ vendor: "", models: catalog.models }]
                ).map((group) => (
                  <React.Fragment key={group.vendor || "all"}>
                    {group.vendor ? (
                      <div
                        className="chat-model-menu-vendor"
                        role="presentation"
                      >
                        {group.vendor}
                      </div>
                    ) : null}
                    {group.models.map((entry) => {
                      const checked = entry.id === modelId;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={checked}
                          className="chat-model-menu-item"
                          onClick={() => {
                            onChange(
                              selectChatModel(
                                catalog,
                                selection,
                                entry.id === catalog.defaultModel
                                  ? ""
                                  : entry.id,
                              ),
                            );
                            setOpen(false);
                          }}
                        >
                          <span>{entry.name}</span>
                          {entry.id === catalog.defaultModel ? (
                            <small>默认</small>
                          ) : null}
                          {checked ? (
                            <Check size={14} aria-hidden="true" />
                          ) : null}
                        </button>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
              {model?.reasoningEfforts.length ? (
                <>
                  <div className="chat-model-menu-heading">思考强度</div>
                  <div
                    className="chat-model-menu-efforts"
                    role="group"
                    aria-label="思考强度"
                  >
                    {model.reasoningEfforts.map((entry) => {
                      const checked =
                        entry.id === (effort ?? model.defaultReasoningEffort);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={checked}
                          className="chat-model-menu-effort"
                          onClick={() => {
                            onChange({
                              ...(selection.model
                                ? { model: selection.model }
                                : {}),
                              ...(entry.id === model.defaultReasoningEffort
                                ? {}
                                : { reasoningEffort: entry.id }),
                            });
                            setOpen(false);
                          }}
                        >
                          {effortName(entry)}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
              <p className="chat-model-menu-note">
                仅影响当前会话，不改变工作流 Agent 的模型配置。
              </p>
            </>
          ) : (
            <div className="chat-model-menu-state" role="status">
              {error ? (
                <>
                  <span>{error}</span>
                  <button
                    type="button"
                    className="chat-model-menu-retry"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    重试
                  </button>
                </>
              ) : (
                <span>正在读取模型…</span>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
