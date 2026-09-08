import type { ChatMessage } from "@aura/protocol/types";

/** Theme preference persisted independently of the system theme. */
export type ThemeMode = "dark" | "light" | "system";
/** A local message, including transient generation status. */
export type Message = ChatMessage & {
  id: string;
  status: "streaming" | "complete" | "stopped" | "error";
};
/** A locally stored conversation. */
export type Session = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
};
/** Version-one client storage; contains no model credentials. */
export type Workspace = {
  version: number;
  theme: ThemeMode;
  reduceMotion: boolean;
  endpoint: string;
  provider: "offline" | "dsh" | "codex";
  sessions: Session[];
};
