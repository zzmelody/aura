/** One rendered line of a file-change card. */
export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

type FileDiff = { oldText: string | null; newText: string };
const cachedDiffs = new WeakMap<
  FileDiff,
  {
    lines: DiffLine[];
    added: number;
    removed: number;
    oldText: string | null;
    newText: string;
  }
>();

/** Shared by collapsed summaries and expanded cards; released with the hunk. */
export function fileDiff(diff: FileDiff) {
  const cached = cachedDiffs.get(diff);
  if (
    cached &&
    cached.oldText === diff.oldText &&
    cached.newText === diff.newText
  )
    return cached;
  const lines = diffLines(diff.oldText, diff.newText);
  const result = {
    lines,
    ...diffStats(lines),
    oldText: diff.oldText,
    newText: diff.newText,
  };
  cachedDiffs.set(diff, result);
  return result;
}

/** Above this many cells the card falls back to "all removed, all added". */
const MAX_CELLS = 250_000;

/**
 * Line diff of one hunk for display. Hunks are small (the change plus three
 * context lines), so a plain longest-common-subsequence table is enough; a
 * pathological size skips alignment rather than stalling the page.
 */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const before = oldText === null ? [] : split(oldText);
  const after = split(newText);
  if (before.length * after.length > MAX_CELLS)
    return [
      ...before.map((text) => ({ kind: "remove" as const, text })),
      ...after.map((text) => ({ kind: "add" as const, text })),
    ];
  // common[i][j]: longest common subsequence of before[i..] and after[j..].
  const common = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i]![j] =
        before[i] === after[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "same", text: before[i]! });
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!)
      lines.push({ kind: "remove", text: before[i++]! });
    else lines.push({ kind: "add", text: after[j++]! });
  }
  while (i < before.length) lines.push({ kind: "remove", text: before[i++]! });
  while (j < after.length) lines.push({ kind: "add", text: after[j++]! });
  return lines;
}

/** Added and removed line counts, for the card header. */
export function diffStats(lines: readonly DiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const line of lines)
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  return { added, removed };
}

/** A trailing newline ends the last line rather than starting an empty one. */
function split(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
