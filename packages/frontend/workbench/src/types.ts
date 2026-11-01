/** Studios are task-specific entry points built on top of workflows. */
export type StudioTab = "studio:coding";
/** Navigation belongs to the client, not the shared conversation model. */
export type Tab =
  | "chat"
  | "flows"
  | StudioTab
  | `plugin:${string}`
  /** Tile home listing every plugin-contributed page. */
  | "studios"
  | "history"
  | "automation"
  | "settings";
