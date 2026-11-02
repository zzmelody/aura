import type { CodingSkillInfo, FlowCatalogEntry } from "@aura/protocol/types";

export type ComposerGroup = "commands" | "skills" | "flows";
export type ComposerCommand = "model" | "stop" | "clear";

export const composerGroups = {
  commands: { title: "内置命令", description: "模型、生成与输入操作" },
  skills: { title: "Skills", description: "为当前任务加载技能指引" },
  flows: { title: "Flows", description: "选择工作流并填写运行参数" },
} satisfies Record<ComposerGroup, { title: string; description: string }>;

interface MenuRow {
  id: string;
  name: string;
  title: string;
  description: string;
  group: ComposerGroup;
  disabled?: boolean;
}

export type ComposerEntry = MenuRow &
  (
    | { kind: "group"; count: number }
    | { kind: "command"; command: ComposerCommand }
    | { kind: "skill"; skill: CodingSkillInfo }
    | { kind: "flow"; flow: FlowCatalogEntry }
  );

/** One catalog powers both the toolbar launcher and slash completion. */
export function composerEntries({
  flows,
  skills,
  query,
  group,
  running,
  canRunFlow,
}: {
  flows: FlowCatalogEntry[];
  skills: CodingSkillInfo[];
  query: string;
  group?: ComposerGroup;
  running: boolean;
  canRunFlow: boolean;
}): ComposerEntry[] {
  const commands: ComposerEntry[] = [
    {
      kind: "command",
      command: "model",
      id: "command:model",
      name: "model",
      title: "选择模型",
      description: "切换当前会话的模型和思考强度",
      group: "commands",
    },
    {
      kind: "command",
      command: "stop",
      id: "command:stop",
      name: "stop",
      title: "停止生成",
      description: "停止当前正在进行的回复",
      group: "commands",
      disabled: !running,
    },
    {
      kind: "command",
      command: "clear",
      id: "command:clear",
      name: "clear",
      title: "清空输入",
      description: "清除当前草稿，保留会话记录",
      group: "commands",
    },
  ];
  const reserved = new Set([
    ...commands.map((entry) => entry.name),
    ...Object.keys(composerGroups),
  ]);
  const entries: ComposerEntry[] = [
    ...commands,
    ...skills
      .filter((skill) => !reserved.has(skill.name))
      .map((skill): ComposerEntry => ({
        kind: "skill",
        id: `skill:${skill.name}`,
        name: skill.name,
        title: skill.name,
        description: skill.description,
        group: "skills",
        skill,
      })),
    ...[...flows]
      .sort((a, b) => Number(b.available) - Number(a.available))
      .map((flow): ComposerEntry => ({
        kind: "flow",
        id: `flow:${flow.id}`,
        name: flow.id,
        title: flow.title,
        description: flow.error || flow.description || flow.id,
        group: "flows",
        disabled: !flow.available || !canRunFlow,
        flow,
      })),
  ];
  const needle = query.trim().toLowerCase();
  if (!group && !needle)
    return (Object.keys(composerGroups) as ComposerGroup[]).map((key) => ({
      ...composerGroups[key],
      kind: "group",
      id: `group:${key}`,
      name: key,
      group: key,
      count: entries.filter((entry) => entry.group === key).length,
    }));
  if (!group && Object.hasOwn(composerGroups, needle))
    return composerEntries({
      flows,
      skills,
      query: "",
      running,
      canRunFlow,
    }).filter((entry) => entry.name === needle);
  return entries
    .filter((entry) => !group || entry.group === group)
    .filter((entry) =>
      `${entry.name} ${entry.title} ${entry.description}`
        .toLowerCase()
        .includes(needle),
    );
}

/** Navigation remains bounded when a catalog shrinks or a search has no hits. */
export function composerIndex(index: number, delta: number, length: number) {
  if (!length) return 0;
  const current = Math.min(Math.max(0, index), length - 1);
  return (current + delta + length) % length;
}

export function skillDraft(name: string, draft: string): string {
  const text = /^\/\S*$/u.test(draft) ? "" : draft.trimStart();
  return `/${name} ${text}`;
}
