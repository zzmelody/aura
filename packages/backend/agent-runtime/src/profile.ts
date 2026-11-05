import { fileURLToPath } from "node:url";

export const agentPresetRoot = fileURLToPath(
  new URL("../presets", import.meta.url),
);
export const agentTeamPlugin = new URL(
  "./conversations/team-plugin.ts",
  import.meta.url,
).href;
