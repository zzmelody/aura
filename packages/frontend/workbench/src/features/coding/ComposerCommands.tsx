import {
  useConversationMessages,
  conversationMessage,
} from "../../conversation-messages.ts";
import {
  formatNumber,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { useAnchoredPopover } from "../../useAnchoredPopover";
import { listSkills } from "./api";
import {
  composerEntries,
  composerGroups,
  composerIndex,
  collaborationPrefix,
  insertCollaborationCommand,
  insertSkill,
  replaceDraftRange,
  skillReferences,
  slashAtCaret,
  type ComposerCommand,
  type ComposerEntry,
  type ComposerGroup,
  type DraftRange,
} from "./composer-commands";
import "./composer-commands.css";

interface DraftSelection extends DraftRange {
  draftKey: string;
  draft: string;
}

export function useComposerCommands({
  endpoint,
  projectId,
  draftKey,
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
  draftKey: string;
  draft: string;
  setDraft(value: string): void;
  flows: FlowCatalogEntry[];
  running: boolean;
  enabled: boolean;
  onFlow?: (flow: FlowCatalogEntry) => void;
  onCommand(command: Exclude<ComposerCommand, "plan" | "goal">): void;
  editor: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useConversationMessages();
  const [launcherKey, setLauncherKey] = useState<string>();
  const [dismissed, setDismissed] = useState<DraftSelection>();
  const [position, setPosition] = useState<DraftSelection>();
  const [composing, setComposing] = useState(false);
  const pendingCaret = useRef<{
    draftKey: string;
    draft: string;
    caret: number;
  }>(null);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<ComposerGroup>();
  const [index, setIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<{
    key: string;
    skills?: CodingSkillInfo[];
    error?: string | MessageReference;
  }>();
  const id = useId();
  const key = `${endpoint}/${projectId}`;
  const skills = catalog?.key === key ? (catalog.skills ?? []) : [];
  const references = skillReferences(draft, skills);
  const command = collaborationPrefix(draft);
  const selection =
    position?.draftKey === draftKey && position.draft === draft
      ? position
      : undefined;
  const slash = selection && slashAtCaret(draft, selection);
  const slashDismissed =
    dismissed?.draftKey === draftKey &&
    dismissed.draft === draft &&
    dismissed.start === slash?.start;
  const inCommand =
    command && slash?.start === command.start && command.end < draft.length;
  const liveSlash = slashDismissed || inCommand ? undefined : slash;
  const launched = launcherKey === draftKey;
  const visible =
    enabled && !composing && (launched || liveSlash !== undefined);
  const skillsError = catalog?.key === key ? catalog.error : undefined;
  const skillsLoading =
    catalog?.key !== key || (!catalog.skills && !catalog.error);
  const query = liveSlash?.query ?? search;
  const entries = composerEntries({
    translate: t,
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
    setCatalog((current) =>
      current?.key === key && current.skills ? current : { key },
    );
    listSkills(endpoint, projectId, abort.signal)
      .then((skills) => {
        if (!abort.signal.aborted) setCatalog({ key, skills });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setCatalog({ key, error: conversationMessage("skillsUnavailable") });
      });
    return () => abort.abort();
  }, [visible, endpoint, projectId, key, revision]);

  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    if (pending.draftKey === draftKey && pending.draft === draft)
      editor.current?.setSelectionRange(pending.caret, pending.caret);
  }, [draft, draftKey, editor]);

  const close = useCallback(() => {
    setLauncherKey(undefined);
    const token = selection && slashAtCaret(draft, selection);
    if (token) setDismissed({ ...token, draft, draftKey });
    setSearch("");
    setGroup(undefined);
    setIndex(0);
    editor.current?.focus();
  }, [draft, draftKey, editor, selection]);

  function trackSelection(input: HTMLTextAreaElement) {
    const next = {
      draftKey,
      draft: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
    };
    setPosition((current) =>
      current?.draftKey === draftKey &&
      current.draft === next.draft &&
      current.start === next.start &&
      current.end === next.end
        ? current
        : next,
    );
    if (!launched && slashAtCaret(input.value, next)?.start !== slash?.start) {
      setGroup(undefined);
      setIndex(0);
    }
  }

  function applyEdit(edit: { draft: string; caret: number }) {
    const next = { ...edit, draftKey };
    setPosition({
      draftKey,
      draft: next.draft,
      start: next.caret,
      end: next.caret,
    });
    if (next.draft === draft) {
      editor.current?.setSelectionRange(next.caret, next.caret);
    } else {
      pendingCaret.current = next;
      setDraft(next.draft);
    }
  }

  function choose(entry: ComposerEntry) {
    if (entry.disabled) return;
    if (entry.kind === "group") {
      setGroup(entry.group);
      setIndex(0);
      setSearch("");
      if (liveSlash?.query) applyEdit(replaceDraftRange(draft, liveSlash, "/"));
      return;
    }
    close();
    if (entry.kind === "skill") {
      const range = liveSlash ?? { start: 0, end: 0 };
      const edit = insertSkill(draft, range, entry.skill.name);
      applyEdit(edit);
      const token = slashAtCaret(edit.draft, {
        start: edit.caret,
        end: edit.caret,
      });
      if (token) setDismissed({ ...token, draftKey, draft: edit.draft });
    } else if (entry.kind === "flow") {
      if (liveSlash) applyEdit(replaceDraftRange(draft, liveSlash, ""));
      onFlow?.(entry.flow);
    } else if (entry.command === "plan" || entry.command === "goal") {
      const range =
        liveSlash && draft.slice(0, liveSlash.start).trim()
          ? liveSlash
          : {
              start: 0,
              end:
                liveSlash?.end ??
                command?.end ??
                (draft.trim() === `/${entry.command}` ? draft.length : 0),
            };
      applyEdit(insertCollaborationCommand(draft, range, entry.command));
    } else {
      if (entry.command === "clear" || draft.trim() === `/${entry.command}`)
        setDraft("");
      else if (liveSlash) applyEdit(replaceDraftRange(draft, liveSlash, ""));
      onCommand(entry.command);
    }
  }

  function handleKey(event: React.KeyboardEvent): boolean {
    if (!visible || event.nativeEvent.isComposing || event.keyCode === 229)
      return false;
    if (event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
      return true;
    }
    if (event.key === "ArrowLeft" && launched && group && !query) {
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
      (event.key === "Enter" && !event.shiftKey) ||
      (event.key === "Tab" && entries[active]) ||
      (event.key === "ArrowRight" &&
        launched &&
        entries[active]?.kind === "group")
    ) {
      event.preventDefault();
      if (entries[active]) choose(entries[active]);
      return true;
    }
    if (event.key === "Tab") close();
    return false;
  }

  return {
    visible,
    id,
    activeId: entries[active] ? `${id}-${active}` : undefined,
    references,
    command,
    query,
    group,
    entries,
    active,
    skillsLoading,
    skillsError,
    searchable: liveSlash === undefined,
    close,
    choose,
    handleKey,
    submitCommand: () => {
      if (!enabled) return false;
      const name = /^\/(model|stop|clear|compact|plan|goal)\s*$/u.exec(
        draft.trimStart(),
      )?.[1];
      if (!name) return false;
      const entry = composerEntries({
        translate: t,
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
    trackSelection,
    setComposing,
    changeDraft: (input: HTMLTextAreaElement) => {
      trackSelection(input);
      setDraft(input.value);
      setDismissed(undefined);
      setIndex(0);
    },
    toggle: () => {
      if (visible) close();
      else {
        setLauncherKey(draftKey);
        setDismissed(undefined);
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
  const { t, i18n } = useConversationMessages();
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
      aria-label={t("conversationCommands")}
    >
      <div className="composer-menu-header">
        {menu.group ? (
          <button
            type="button"
            className="composer-menu-back"
            aria-label={t("backShortcuts")}
            onClick={menu.back}
          >
            <ArrowLeft size={14} />
          </button>
        ) : null}
        <span className="composer-menu-title">
          {menu.group ? t(composerGroups[menu.group].title) : t("shortcuts")}
        </span>
        <button
          type="button"
          className="composer-menu-close"
          aria-label={t("closeShortcuts")}
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
            aria-label={t("searchCommands")}
            aria-controls={menu.id}
            aria-activedescendant={menu.activeId}
            value={menu.query}
            placeholder={t("searchCommandsPlaceholder")}
            onChange={(event) => menu.setQuery(event.target.value)}
            onKeyDown={menu.handleKey}
          />
        </label>
      ) : null}
      <div
        className="composer-menu-list"
        id={menu.id}
        role="listbox"
        aria-label={
          menu.group ? t(composerGroups[menu.group].title) : t("shortcuts")
        }
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
                    : formatNumber(entry.count)}
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </span>
            ) : entry.kind === "command" ? (
              <code className="composer-menu-alias">/{entry.name}</code>
            ) : (
              <span className="composer-menu-kind">
                {entry.disabled
                  ? t("unavailable")
                  : entry.kind === "skill"
                    ? "Skill"
                    : "Flow"}
              </span>
            )}
          </button>
        ))}
        {!menu.entries.length ? (
          <p className="composer-menu-empty" role="status">
            {loading ? t("loadingCatalog") : t("noItems")}
          </p>
        ) : null}
      </div>
      {menu.skillsError && (!menu.group || menu.group === "skills") ? (
        <div className="composer-menu-error" role="status">
          {messageText(menu.skillsError, i18n)}
          <button type="button" onClick={menu.retry}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      <div className="composer-menu-footer" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          {t("select")}
        </span>
        <span>
          <kbd>↵</kbd>
          {t("confirm")}
        </span>
        <span className="composer-menu-dismiss">
          <kbd>Esc</kbd>
          {t("close")}
        </span>
      </div>
    </div>
  );
}
