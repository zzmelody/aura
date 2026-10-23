import type { Tab } from "./types.ts";

/** Existing chat/workflow shortcuts retain their destinations after plugin extraction. */
export function migratedStudioTab(tab: Tab): Tab {
  const aliases: Partial<Record<Tab, Tab>> = {
    "studio:content": "plugin:self-media/content",
    "studio:video": "plugin:self-media/video",
    "studio:research": "plugin:self-media/topics",
    site: "plugin:site-launcher/sites",
  };
  return aliases[tab] ?? tab;
}
