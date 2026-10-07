/** Studios are task-specific entry points built on top of workflows. */
export type StudioTab = "studio:content" | "studio:video" | "studio:research";
/** Navigation belongs to the client, not the shared conversation model. */
export type Tab =
  "chat" | "flows" | StudioTab | "history" | "site" | "settings";
