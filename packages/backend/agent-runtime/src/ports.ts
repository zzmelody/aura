import type {
  ChatWorkflowStart,
  CodingProjectInfo,
  FlowMode,
} from "@aura/protocol/types";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

export interface ConversationWorkspaces {
  list(): CodingProjectInfo[];
  defaultProject(): Promise<CodingProjectInfo>;
  directory(projectId: string): string;
  attach(projectId: string, sessionId: string): Promise<void>;
}

export type ConversationTools = (scope: {
  mode: FlowMode;
  sessionId: string;
  signal: AbortSignal;
  started(run: ChatWorkflowStart): void;
}) => readonly ToolDefinition[];
