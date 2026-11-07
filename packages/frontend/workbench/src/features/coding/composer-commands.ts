import {
  conversationText,
  type ConversationMessageKey,
} from "../../conversation-messages.ts";
import type { CodingSkillInfo, FlowCatalogEntry } from "@aura/protocol/types";
import { flowTitle, flowDescription } from "../../metadata.ts";

export type ComposerGroup = "commands" | "skills" | "flows";
export type ComposerCommand =
  "model" | "stop" | "clear" | "compact" | "plan" | "goal";

export type CollaborationCommand = Extract<ComposerCommand, "plan" | "goal">;

export function collaborationPrefix(draft: string): DraftRange | undefined {
  const token = /^\/(plan|goal)(?=\s|$)/u.exec(draft)?.[0];
  return token ? { start: 0, end: token.length } : undefined;
}

export function collaborationCommand(
  draft: string,
):
  | { action: "execute" | "pause" | "resume" | "clear" }
  | { action: "plan" | "goal"; prompt: string }
  | undefined {
  const match = /^\/(plan|goal)\s+([\s\S]+)$/u.exec(draft.trim());
  const prompt = match?.[2]?.trim();
  if (!match || !prompt) return undefined;
  if (match[1] === "plan")
    return prompt === "off"
      ? { action: "execute" }
      : { action: "plan", prompt };
  if (prompt === "pause" || prompt === "resume" || prompt === "clear")
    return { action: prompt };
  return { action: "goal", prompt };
}

export const composerGroups = {
  commands: { title: "commands", description: "commandsHint" },
  skills: { title: "skills", description: "skillsHint" },
  flows: { title: "flows", description: "flowsHint" },
} satisfies Record<
  ComposerGroup,
  { title: ConversationMessageKey; description: ConversationMessageKey }
>;

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

const BUILT_IN_COMMANDS = [
  {
    kind: "command",
    command: "plan",
    id: "command:plan",
    name: "plan",
    title: "planMode",
    description: "planHint",
    group: "commands",
  },
  {
    kind: "command",
    command: "goal",
    id: "command:goal",
    name: "goal",
    title: "goalMode",
    description: "goalHint",
    group: "commands",
  },
  {
    kind: "command",
    command: "compact",
    id: "command:compact",
    name: "compact",
    title: "compact",
    description: "compactHint",
    group: "commands",
  },
  {
    kind: "command",
    command: "model",
    id: "command:model",
    name: "model",
    title: "selectModel",
    description: "selectModelHint",
    group: "commands",
  },
  {
    kind: "command",
    command: "stop",
    id: "command:stop",
    name: "stop",
    title: "stop",
    description: "stopHint",
    group: "commands",
  },
  {
    kind: "command",
    command: "clear",
    id: "command:clear",
    name: "clear",
    title: "clearDraft",
    description: "clearDraftHint",
    group: "commands",
  },
] satisfies Array<
  ComposerEntry & {
    title: ConversationMessageKey;
    description: ConversationMessageKey;
  }
>;

const RESERVED_NAMES = new Set([
  ...BUILT_IN_COMMANDS.map((entry) => entry.name),
  ...Object.keys(composerGroups),
]);

/** One catalog powers both the toolbar launcher and slash completion. */
export function composerEntries({
  flows,
  skills,
  query,
  group,
  running,
  canRunFlow,
  translate = conversationText,
}: {
  flows: FlowCatalogEntry[];
  skills: CodingSkillInfo[];
  query: string;
  group?: ComposerGroup;
  running: boolean;
  canRunFlow: boolean;
  translate?: (key: ConversationMessageKey) => string;
}): ComposerEntry[] {
  const entries: ComposerEntry[] = [
    ...BUILT_IN_COMMANDS.map((entry) => ({
      ...entry,
      title: translate(entry.title),
      description: translate(entry.description),
      disabled:
        entry.command === "stop"
          ? !running
          : running && ["plan", "goal", "compact"].includes(entry.command),
    })),
    ...skills
      .filter((skill) => !RESERVED_NAMES.has(skill.name))
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
        title: flowTitle(flow),
        description: flow.error || flowDescription(flow) || flow.id,
        group: "flows",
        disabled: !flow.available || !canRunFlow,
        flow,
      })),
  ];
  const needle = query.trim().toLowerCase();
  if (!group && !needle)
    return (Object.keys(composerGroups) as ComposerGroup[]).map((key) => ({
      title: translate(composerGroups[key].title),
      description: translate(composerGroups[key].description),
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
      translate,
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

export interface DraftRange {
  start: number;
  end: number;
}

export function slashAtCaret(
  draft: string,
  selection: DraftRange,
): (DraftRange & { query: string }) | undefined {
  if (selection.start !== selection.end) return undefined;
  const end = selection.end;
  const start = draft.lastIndexOf("/", end - 1);
  if (end === 0 || start < 0) return undefined;
  const before = draft.charAt(start - 1);
  const query = draft.slice(start + 1, end);
  if (
    /[\p{L}\p{N}_/\\]/u.test(before) ||
    (before === ":" && /\S/u.test(draft.charAt(start - 2))) ||
    /\s/u.test(query)
  )
    return undefined;
  return { start, end, query };
}

export function replaceDraftRange(
  draft: string,
  { start, end }: DraftRange,
  text: string,
): { draft: string; caret: number } {
  return {
    draft: draft.slice(0, start) + text + draft.slice(end),
    caret: start + text.length,
  };
}

export function insertSkill(
  draft: string,
  range: DraftRange,
  name: string,
): { draft: string; caret: number } {
  const prefix = /\S/u.test(draft.charAt(range.start - 1)) ? " " : "";
  const next = draft.charAt(range.end);
  const result = replaceDraftRange(
    draft,
    range,
    `${prefix}/${name}${!next || /\S/u.test(next) ? " " : ""}`,
  );
  if (/[^\S\r\n]/u.test(next)) result.caret += 1;
  return result;
}

/**
 * Plan and goal only take effect as the draft's prefix, so a pick moves the
 * command to the front: `range` is the text it replaces (the typed slash token,
 * or the existing prefix), and text already typed before it becomes the prompt.
 */
export function insertCollaborationCommand(
  draft: string,
  range: DraftRange,
  command: CollaborationCommand,
): { draft: string; caret: number } {
  const token = `/${command}`;
  let before = draft.slice(0, range.start);
  const suffix = draft.slice(range.end);
  if (before.trim()) {
    // A pick replaces any earlier plan/goal prefix instead of stacking them.
    const prefix = collaborationPrefix(before);
    if (prefix) before = before.slice(prefix.end);
    before = before.trimStart();
    return {
      draft: `${token} ${before}${suffix}`,
      caret: token.length + 1 + before.length,
    };
  }
  const next = suffix.charAt(0);
  if (/\s/u.test(next))
    return {
      draft: token + suffix,
      caret: token.length + Number(next === " "),
    };
  return { draft: token + " " + suffix, caret: token.length + 1 };
}

export function commandDeletionRange(
  draft: string,
  command: DraftRange,
  selection: DraftRange,
  backward: boolean,
): DraftRange | undefined {
  const end = command.end + Number(draft.charAt(command.end) === " ");
  if (selection.start !== selection.end) return undefined;
  const caret = selection.start;
  const touches = backward
    ? caret > command.start && caret <= end
    : caret >= command.start && caret < command.end;
  return touches ? { start: command.start, end } : undefined;
}

export function skillReferences(
  draft: string,
  skills: CodingSkillInfo[],
): DraftRange[] {
  if (!skills.length || !draft.includes("/")) return [];
  const names = new Set(skills.map(({ name }) => name));
  return Array.from(
    draft.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu),
  ).flatMap((match) =>
    names.has(match[2]) && !RESERVED_NAMES.has(match[2])
      ? [
          {
            start: match.index + match[1].length,
            end: match.index + match[0].length,
          },
        ]
      : [],
  );
}
