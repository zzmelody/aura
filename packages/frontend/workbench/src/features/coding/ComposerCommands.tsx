import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Eraser,
  Search,
  SlidersHorizontal,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { CodingSkillInfo, FlowCatalogEntry } from "@aura/protocol/types";
import { FlowIcon } from "../../FlowIcon";
import { slashQuery } from "../../flowPicker";
import { useAnchoredPopover } from "../../useAnchoredPopover";
import { listSkills } from "./api";
import {
  composerEntries,
  composerGroups,
  composerIndex,
  skillDraft,
  type ComposerCommand,
  type ComposerEntry,
  type ComposerGroup,
} from "./composer-commands";
import "./composer-commands.css";

export function useComposerCommands({
  endpoint,
  projectId,
  draft,
  setDraft,
  flows,
  running,
  enabled,
  onFlow,
  onCommand,
  editor,
}: {
  endpoint: string;
  projectId?: string;
  draft: string;
  setDraft(value: string): void;
  flows: FlowCatalogEntry[];
  running: boolean;
  enabled: boolean;
  onFlow?: (flow: FlowCatalogEntry) => void;
  onCommand(command: ComposerCommand): void;
  editor: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [launched, setLaunched] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<ComposerGroup>();
  const [index, setIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<{
    key: string;
    skills?: CodingSkillInfo[];
    error?: string;
  }>();
  const id = useId();
  const slash = slashQuery(draft);
  const visible =
    enabled && (launched || (slash !== undefined && dismissed !== draft));
  const key = `${endpoint}/${projectId}`;
  const skills = catalog?.key === key ? (catalog.skills ?? []) : [];
  const skillsError = catalog?.key === key ? catalog.error : undefined;
  const skillsLoading =
    catalog?.key !== key || (!catalog.skills && !catalog.error);
  const query = slash ?? search;
  const entries = composerEntries({
    flows,
    skills,
    query,
    group,
    running,
    canRunFlow: Boolean(onFlow),
  });
  const active = Math.min(index, Math.max(0, entries.length - 1));

  useEffect(() => {
    if (!visible || !projectId) return;
    const abort = new AbortController();
    setCatalog({ key });
    listSkills(endpoint, projectId, abort.signal)
      .then((skills) => {
        if (!abort.signal.aborted) setCatalog({ key, skills });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setCatalog({ key, error: "Skills 暂时无法读取" });
      });
    return () => abort.abort();
  }, [visible, endpoint, projectId, key, revision]);

  const close = useCallback(() => {
    setLaunched(false);
    setDismissed(draft);
    setSearch("");
    setGroup(undefined);
    setIndex(0);
    editor.current?.focus();
  }, [draft, editor]);

  function choose(entry: ComposerEntry) {
    if (entry.disabled) return;
    if (entry.kind === "group") {
      setGroup(entry.group);
      setIndex(0);
      setSearch("");
      if (slash) setDraft("/");
      return;
    }
    close();
    if (entry.kind === "skill") {
      setDraft(skillDraft(entry.skill.name, draft));
      editor.current?.focus();
    } else if (entry.kind === "flow") {
      if (slash !== undefined) setDraft("");
      onFlow?.(entry.flow);
    } else {
      if (
        slash !== undefined ||
        entry.command === "clear" ||
        draft.trim() === `/${entry.command}`
      )
        setDraft("");
      onCommand(entry.command);
    }
  }

  function handleKey(event: React.KeyboardEvent): boolean {
    if (!visible || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
      return true;
    }
    if (event.key === "ArrowLeft" && group && !query) {
      event.preventDefault();
      setGroup(undefined);
      setIndex(0);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(
        composerIndex(
          active,
          event.key === "ArrowDown" ? 1 : -1,
          entries.length,
        ),
      );
      return true;
    }
    if (
      event.key === "Enter" ||
      (event.key === "Tab" && entries[active]) ||
      (event.key === "ArrowRight" && entries[active]?.kind === "group")
    ) {
      event.preventDefault();
      if (entries[active]) choose(entries[active]);
      return true;
    }
    return false;
  }

  return {
    visible,
    id,
    activeId: entries[active] ? `${id}-${active}` : undefined,
    slash,
    query,
    group,
    entries,
    active,
    skillsLoading,
    skillsError,
    searchable: slash === undefined,
    close,
    choose,
    handleKey,
    submitCommand: () => {
      const name = /^\/(model|stop|clear|plan|goal)\s*$/u.exec(draft)?.[1];
      if (!name) return false;
      const entry = composerEntries({
        flows,
        skills,
        query: name,
        group: "commands",
        running,
        canRunFlow: Boolean(onFlow),
      }).find((entry) => entry.name === name);
      if (entry) choose(entry);
      return true;
    },
    retry: () => setRevision((value) => value + 1),
    back: () => {
      setGroup(undefined);
      setIndex(0);
    },
    setActive: setIndex,
    setQuery: (value: string) => {
      setSearch(value);
      setIndex(0);
    },
    changeDraft: (value: string) => {
      setDraft(value);
      setDismissed(undefined);
      setIndex(0);
      if (slash === undefined || slashQuery(value) === undefined)
        setGroup(undefined);
    },
    toggle: () => {
      if (visible) close();
      else {
        setLaunched(true);
        setGroup(undefined);
        setIndex(0);
        editor.current?.focus();
      }
    },
  };
}

type ComposerMenu = ReturnType<typeof useComposerCommands>;

function EntryIcon({ entry }: { entry: ComposerEntry }) {
  if (entry.group === "skills") return <BookOpen size={16} />;
  if (entry.group === "flows") return <FlowIcon size={16} />;
  const Icon =
    entry.kind !== "command"
      ? Terminal
      : entry.command === "model"
        ? SlidersHorizontal
        : entry.command === "stop"
          ? Square
          : Eraser;
  return <Icon size={16} />;
}

/** One compact, drillable menu above the entire composer card. */
export function ComposerCommands({
  menu,
  anchor,
  flowsLoading,
}: {
  menu: ComposerMenu;
  anchor: React.RefObject<HTMLDivElement | null>;
  flowsLoading: boolean;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { visible, searchable, close, active, group } = menu;
  useAnchoredPopover(menu.visible, anchor, popup, {
    placement: "above",
    align: "start",
    maxHeight: 320,
  });
  useEffect(() => {
    if (!visible) return;
    if (searchable) search.current?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !anchor.current?.contains(target))
        close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [visible, searchable, close, anchor]);
  useEffect(() => {
    if (visible)
      popup.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [visible, active, group]);
  if (!menu.visible) return null;
  const loading =
    menu.group === "skills"
      ? menu.skillsLoading
      : menu.group === "flows" && flowsLoading;
  return (
    <div
      ref={popup}
      popover="manual"
      className="composer-menu"
      role="dialog"
      aria-label="对话命令"
    >
      <div className="composer-menu-header">
        {menu.group ? (
          <button
            type="button"
            className="composer-menu-back"
            aria-label="返回快捷入口"
            onClick={menu.back}
          >
            <ArrowLeft size={14} />
          </button>
        ) : null}
        <span className="composer-menu-title">
          {menu.group ? composerGroups[menu.group].title : "快捷入口"}
        </span>
        <button
          type="button"
          className="composer-menu-close"
          aria-label="关闭快捷入口"
          onClick={close}
        >
          <X size={14} />
        </button>
      </div>
      {menu.searchable ? (
        <label className="composer-menu-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={search}
            aria-label="搜索命令、Skills 和 Flows"
            aria-controls={menu.id}
            aria-activedescendant={menu.activeId}
            value={menu.query}
            placeholder="搜索命令、Skills 和 Flows…"
            onChange={(event) => menu.setQuery(event.target.value)}
            onKeyDown={menu.handleKey}
          />
        </label>
      ) : null}
      <div
        className="composer-menu-list"
        id={menu.id}
        role="listbox"
        aria-label={menu.group ? composerGroups[menu.group].title : "快捷入口"}
      >
        {menu.entries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="option"
            id={`${menu.id}-${index}`}
            data-index={index}
            aria-selected={menu.active === index}
            aria-disabled={entry.disabled || undefined}
            className="composer-menu-option"
            onMouseMove={() => menu.setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => menu.choose(entry)}
            title={entry.description}
          >
            <span className="composer-menu-icon" aria-hidden="true">
              <EntryIcon entry={entry} />
            </span>
            <span className="composer-menu-copy">
              <strong>{entry.title}</strong>
              <span>{entry.description}</span>
            </span>
            {entry.kind === "group" ? (
              <span className="composer-menu-tail">
                <span className="composer-menu-count">
                  {entry.group === "skills" && menu.skillsLoading
                    ? "…"
                    : entry.count}
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </span>
            ) : entry.kind === "command" ? (
              <code className="composer-menu-alias">/{entry.name}</code>
            ) : (
              <span className="composer-menu-kind">
                {entry.disabled
                  ? "不可用"
                  : entry.kind === "skill"
                    ? "Skill"
                    : "Flow"}
              </span>
            )}
          </button>
        ))}
        {!menu.entries.length ? (
          <p className="composer-menu-empty" role="status">
            {loading ? "正在读取目录…" : "没有匹配的项目"}
          </p>
        ) : null}
      </div>
      {menu.skillsError && (!menu.group || menu.group === "skills") ? (
        <div className="composer-menu-error" role="status">
          {menu.skillsError}
          <button type="button" onClick={menu.retry}>
            重试
          </button>
        </div>
      ) : null}
      <div className="composer-menu-footer" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择
        </span>
        <span>
          <kbd>↵</kbd> 确认
        </span>
        <span className="composer-menu-dismiss">
          <kbd>Esc</kbd> 关闭
        </span>
      </div>
    </div>
  );
}
