import type {} from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";

import { MessageId, type UserMessage } from "@deepseek-ai/dsh-llm";
import { recordKeyFor } from "@deepseek-ai/dsh-llm-pi-ai";

const providerId = "openai-codex";
/** Refresh ahead of expiry so a long image request never starts on a dying token. */
const MIN_VALIDITY_MS = 10 * 60_000;

/** A request-ready Codex subscription token; never logged or persisted here. */
export interface CodexAccessToken {
  token: string;
  accountId: string;
}

/** Narrow port for backend services that call the Codex subscription backend. */
export interface CodexTokenSource {
  /** True while a Codex subscription login is stored. */
  signedIn(): Promise<boolean>;
  /** A valid token; refreshed by DSH's own Codex adapter when near expiry. */
  token(signal?: AbortSignal): Promise<CodexAccessToken | undefined>;
}

/** ChatGPT account ID carried in the access token's OpenAI claim. */
export function codexAccountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The stored grant's access token and expiry, or undefined when absent. */
export function readCodexGrant(
  record: unknown,
): { access: string; expires: number } | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = record as { kind?: unknown; payload?: unknown };
  if (
    value.kind !== "grant" ||
    !value.payload ||
    typeof value.payload !== "object"
  )
    return undefined;
  const payload = value.payload as { access?: unknown; expires?: unknown };
  if (typeof payload.access !== "string" || typeof payload.expires !== "number")
    return undefined;
  return { access: payload.access, expires: payload.expires };
}

/**
 * Reads the DSH-stored Codex grant the chat route uses. Aura never refreshes
 * the OAuth grant itself: when the token is close to expiry, one minimal
 * model call through DSH lets the official adapter rotate and persist it.
 */
export function codexTokenSource(
  ctx: Context,
  model: string,
  now: () => number = Date.now,
): CodexTokenSource {
  const read = async () =>
    readCodexGrant(
      await ctx.get("credentials")?.readRecord(recordKeyFor(providerId)),
    );
  let refreshing: Promise<void> | undefined;
  const refresh = (signal?: AbortSignal) =>
    (refreshing ??= (async () => {
      try {
        const message: UserMessage = {
          id: MessageId("aura-codex-token-check"),
          role: "user",
          content: [{ type: "text", text: "ok" }],
          source: { kind: "user" },
        };
        for await (const _ of ctx.llm.stream({
          provider: providerId,
          model,
          messages: [message],
          maxTokens: 16,
          signal: signal ?? AbortSignal.timeout(60_000),
        }))
          break;
      } finally {
        refreshing = undefined;
      }
    })());
  return {
    async signedIn() {
      return (
        (await ctx.get("credentials")?.describeRecord(recordKeyFor(providerId)))
          ?.configured === true
      );
    },
    async token(signal) {
      let grant = await read();
      if (!grant) return undefined;
      if (grant.expires - now() < MIN_VALIDITY_MS) {
        await refresh(signal).catch(() => undefined);
        grant = await read();
        if (!grant || grant.expires - now() < 60_000) return undefined;
      }
      const accountId = codexAccountId(grant.access);
      return accountId ? { token: grant.access, accountId } : undefined;
    },
  };
}
