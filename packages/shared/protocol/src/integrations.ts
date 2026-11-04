export interface IntegrationFlags {
  mcp: boolean;
  market: boolean;
  voice: boolean;
  agentTeam: boolean;
  sessionSearch: boolean;
}

export type McpServerInput = { name: string } & (
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | { transport: "streamable-http"; url: string; bearerEnv?: string }
);

export interface IntegrationSettings {
  revision: number;
  flags: IntegrationFlags;
  mcpServers: Array<{
    name: string;
    transport: McpServerInput["transport"];
    tools: string[];
    status: "disabled" | "connecting" | "connected" | "unavailable";
  }>;
  voicePhase: string;
}

export interface IntegrationUpdate {
  revision: number;
  flags?: IntegrationFlags;
  server?: McpServerInput;
  removeServer?: string;
}

export interface ConversationSearchHit {
  id: string;
  title: string;
  snippet: string;
}

export interface AgentTeamView {
  members: Array<{ name: string; status: string }>;
  tasks: Array<{ id: string; subject: string; status: string; owner?: string }>;
}

export interface MarketListing {
  name: string;
  title: string;
  description: string;
  version: string;
  sourceUrl?: string;
}
