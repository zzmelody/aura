import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import TeamService, {
  type Config as TeamConfig,
} from "@deepseek-ai/dsh-experimental-agent-team";

export const name = "aura-agent-team";
export const Config = TeamService.Config;
export const inject = TeamService.inject;

/** Keep native team tools off Flow and ordinary subagent scopes. */
class CodingTeams extends TeamService {
  override tryMembership(agent: Agent) {
    const member = super.tryMembership(agent);
    return member?.root.session.header.agentPreset === "coder-v1"
      ? member
      : undefined;
  }
}

export async function apply(ctx: Context, config: TeamConfig) {
  await ctx.plugin(CodingTeams, config).await();
}
