import type { FlowMode } from "@aura/protocol/types";
import type { Workspace } from "./types.ts";
/** Flow and chat mode served by a workspace provider; offline is the demo. */
export function providerMode(provider: Workspace["provider"]): FlowMode {
  return provider === "offline" ? "demo" : provider;
}

/** Version-one storage key; moving modules does not migrate or erase records. */
export const STORAGE_KEY = "aura.workspace.v1";

/** Returns an empty local workspace. */
export function initialState(): Workspace {
  return {
    version: 1,
    theme: "dark",
    reduceMotion: false,
    endpoint: "",
    provider: "offline",
    sessions: [],
  };
}
