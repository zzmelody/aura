/** Keep recent transcripts, always retaining the selected and streaming conversations. */
export function retainConversations<T>(
  entries: Record<string, T>,
  selectedId: string | undefined,
  runningIds: Iterable<string>,
  capacity = 6,
): Record<string, T> {
  const protectedIds = new Set(runningIds);
  if (selectedId) protectedIds.add(selectedId);
  const ids = Object.keys(entries);
  const idle = ids.filter((id) => !protectedIds.has(id));
  const removing = new Set(idle.slice(0, Math.max(0, ids.length - capacity)));
  return removing.size
    ? Object.fromEntries(
        Object.entries(entries).filter(([id]) => !removing.has(id)),
      )
    : entries;
}
