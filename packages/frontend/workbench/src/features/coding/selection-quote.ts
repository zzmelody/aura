/** Longest selection carried into a draft; longer text is truncated. */
export const MAX_QUOTE_LENGTH = 4000;

/** Formats selected transcript text as a Markdown quote for a composer draft. */
export function selectionQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const bounded =
    normalized.length > MAX_QUOTE_LENGTH
      ? `${normalized.slice(0, MAX_QUOTE_LENGTH)}…`
      : normalized;
  return `${bounded
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}
