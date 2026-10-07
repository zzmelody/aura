import type { FlowCatalogEntry, JsonValue } from "@aura/protocol/types";

/** Available flows first, then the catalog order; matches title, purpose or ID. */
export function filterFlows(flows: FlowCatalogEntry[], query: string) {
  const needle = query.trim().toLowerCase();
  return flows
    .filter((flow) =>
      `${flow.title} ${flow.description} ${flow.id}`
        .toLowerCase()
        .includes(needle),
    )
    .sort((a, b) => Number(b.available) - Number(a.available));
}

/** A slash at the start of the composer opens the picker with what follows. */
export function slashQuery(draft: string): string | undefined {
  return /^\/\S*$/u.test(draft) ? draft.slice(1) : undefined;
}

/**
 * Seeds the first string field with what the user already typed, so a chat
 * request becomes the Flow's main prompt instead of being discarded.
 */
export function prefillFlowInput(
  initial: JsonValue,
  schema: JsonValue | undefined,
  text: string,
): JsonValue {
  const prompt = text.trim();
  if (
    !prompt ||
    !initial ||
    typeof initial !== "object" ||
    Array.isArray(initial) ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  )
    return initial;
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return initial;
  const key = Object.entries(properties).find(
    ([, field]) =>
      field &&
      typeof field === "object" &&
      !Array.isArray(field) &&
      field.type === "string" &&
      !field.enum,
  )?.[0];
  return key ? { ...initial, [key]: prompt } : initial;
}
