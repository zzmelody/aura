import { httpPage } from "@aura/protocol/browser";

/** A browser tab as saved for its conversation: address and title, never page state. */
export interface SavedBrowser {
  id: string;
  title: string;
  /** Last observed HTTP(S) page; empty before the first navigation. */
  url: string;
}

/** The tool panel of one main conversation, mirroring DSH's per-session sidebar. */
export interface ToolLayout {
  browsers: SavedBrowser[];
  selected?: string;
  visible?: boolean;
}

const PREFIX = "aura.coding.tools.v1.";
const MAX_BROWSERS = 12;

/** Validates one stored layout; anything malformed is dropped, not repaired. */
export function parseToolLayout(raw: unknown): ToolLayout | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { browsers, selected, visible } = raw as Record<string, unknown>;
  if (!Array.isArray(browsers) || browsers.length > MAX_BROWSERS)
    return undefined;
  const saved: SavedBrowser[] = [];
  for (const item of browsers as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { id, title, url } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^browser-[0-9a-f-]{36}$/u.test(id) ||
      typeof title !== "string" ||
      title.length > 100 ||
      typeof url !== "string" ||
      (url !== "" && httpPage(url)?.href !== url)
    )
      return undefined;
    saved.push({ id, title, url });
  }
  if (selected !== undefined && typeof selected !== "string") return undefined;
  if (visible !== undefined && typeof visible !== "boolean") return undefined;
  return {
    browsers: saved,
    ...(selected !== undefined ? { selected } : {}),
    ...(visible !== undefined ? { visible } : {}),
  };
}

function emptyLayout(layout: ToolLayout): boolean {
  return (
    !layout.browsers.length &&
    layout.selected === undefined &&
    layout.visible === undefined
  );
}

/** Reads saved conversation layouts without changing browser storage. */
export function loadToolLayouts(storage?: Storage): Record<string, ToolLayout> {
  const layouts: Record<string, ToolLayout> = {};
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return layouts;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const layout = parseToolLayout(
          JSON.parse(storage.getItem(key) ?? "null"),
        );
        if (layout) layouts[key.slice(PREFIX.length)] = layout;
      } catch {
        // Ignore a malformed entry without losing other saved layouts.
      }
    }
  } catch {
    // Storage can be unavailable in private or embedded contexts; layouts stay in memory.
  }
  return layouts;
}

/** Saves one conversation's layout; an empty layout removes its key. */
export function saveToolLayout(
  owner: string,
  layout: ToolLayout,
  storage?: Storage,
): void {
  try {
    storage ??= globalThis.localStorage;
    if (emptyLayout(layout)) storage?.removeItem(PREFIX + owner);
    else storage?.setItem(PREFIX + owner, JSON.stringify(layout));
  } catch {
    // The layout keeps working for this visit when persistence is blocked.
  }
}
