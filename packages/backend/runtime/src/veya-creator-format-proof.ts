import { createHash } from "node:crypto";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Verify recorded punctuation deletion, not a new correction or model result.
 * Only the one/two recorded original offsets are considered, in either order.
 * Every removed byte must be outside a string and inside the current parser's
 * 32-character error window; everything else, including whitespace, is exact. */
export function verifyDesignFormatProof(raw: string, rawHash: string, revised: unknown, value: unknown): void {
  const proof = object(value), recorded = proof?.formatOffsets;
  const refuse = (): never => { throw new Error("previous_request_unavailable"); };
  if (!proof || hash(raw) !== rawHash || proof.beforeHash !== rawHash || proof.formatSourceHash !== rawHash ||
      proof.afterHash !== hash(JSON.stringify(revised)) || proof.formatCorrected !== true ||
      !Array.isArray(recorded) || recorded.length < 1 || recorded.length > 2 ||
      recorded.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n >= raw.length || (i > 0 && n <= recorded[i - 1])) ||
      proof.formatMethod !== (recorded.length === 1 ? "unique_closing_bracket" : "unique_closing_brackets") ||
      (recorded.length === 1 ? proof.formatOffset !== recorded[0] : proof.formatOffset !== undefined) ||
      !Array.isArray(proof.issues) || object(proof.issues[0])?.code !== "invalid_spec") refuse();
  const offsets = recorded as number[];
  const permitted = new Set<number>();
  let quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === "}" || ch === "]") permitted.add(i);
  }
  if (offsets.some(n => !permitted.has(n))) refuse();
  const orders = offsets.length === 1 ? [offsets] : [offsets, [...offsets].reverse()];
  for (const order of orders) {
    let current = raw, valid = true;
    const removed: number[] = [];
    for (const originalOffset of order) {
      let errorPosition = -1;
      try { JSON.parse(current); } catch (error) {
        if (error instanceof SyntaxError) {
          const match = /\bposition ([0-9]+)/u.exec(String(error));
          if (match) errorPosition = Number(match[1]);
        }
      }
      const offset = originalOffset - removed.filter(n => n < originalOffset).length;
      if (errorPosition < 0 || offset < Math.max(0, errorPosition - 32) || offset > errorPosition) { valid = false; break; }
      current = current.slice(0, offset) + current.slice(offset + 1);
      removed.push(originalOffset);
    }
    if (!valid || hash(current) !== proof!.formatResultHash) continue;
    try { if (object(JSON.parse(current))) return; } catch { /* A recorded deletion never authorizes another repair. */ }
  }
  refuse();
}
