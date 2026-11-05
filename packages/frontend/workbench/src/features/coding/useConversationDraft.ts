import { useCallback, useState } from "react";
import type { SetStateAction } from "react";

/** Each conversation restores its seed without sharing drafts with other tabs. */
export function useConversationDraft(key: string, initialDraft?: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[key] ?? initialDraft ?? "";
  const setDraft = useCallback(
    (value: SetStateAction<string>) =>
      setDrafts((current) => ({
        ...current,
        [key]:
          typeof value === "function"
            ? value(current[key] ?? initialDraft ?? "")
            : value,
      })),
    [key, initialDraft],
  );
  const moveDraft = useCallback(
    (target: string) =>
      setDrafts((current) => {
        const { [key]: previous, ...rest } = current;
        return { ...rest, [target]: previous ?? initialDraft ?? "" };
      }),
    [key, initialDraft],
  );
  // A restored seed is only a fallback. Parent echoes must never overwrite
  // local edits or quoted text that has just been appended to this draft.
  return { draft, setDraft, moveDraft };
}
