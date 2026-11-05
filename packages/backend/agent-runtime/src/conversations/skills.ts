import type { CodingSkillInfo } from "@aura/protocol/types";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";

/** Project selection is resolved by the caller, never supplied as a file path. */
export async function codingSkills(
  skills: Pick<Context["skills"], "list">,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodingSkillInfo[]> {
  const catalog = await skills.list({ cwd, signal });
  return catalog
    .filter((skill) => skill.invocation.userInvocable)
    .map(({ name, description }) => ({ name, description }));
}
