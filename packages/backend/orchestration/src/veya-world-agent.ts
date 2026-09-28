import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { GeneratedArtifacts, readBoundedFile } from "./generated-artifacts.ts";
import type { JsonValue } from "@aura/protocol/types";
import type { AuraCapabilityClient } from "./action-api.ts";
import { ActionFailure } from "./action-api.ts";

export const VEYA_WORLD_AGENT_CAPABILITY = "aura.veya.world-agent";

type Operation = { method: "GET" | "POST"; path?: string; tool?: string };

const operations = new Map<string, Operation>([
  ["veya.assets.import", { method: "POST", tool: "veya.assets.import" }],
  ...["mode", "undo", "redo"].map((name): [string, Operation] => [
    `veya.world.${name}`,
    { method: "POST", path: `/v2/worlds/${name}`, tool: `veya.world.${name}` },
  ]),
  ...[
    "draft.create",
    "draft.read",
    "draft.update",
    "draft.discard",
    "playtest.begin",
    "playtest.end",
    "character.navigate",
    "character.act",
    "character.cancel",
  ].map((name): [string, Operation] => [
    `veya.${name}`,
    { method: "POST", tool: `veya.${name}` },
  ]),
  ["health", { method: "GET", path: "/v1/health" }],
  ["veya.system.context", { method: "POST", tool: "veya.system.context" }],
  [
    "veya.world.list",
    { method: "POST", path: "/v2/worlds/list", tool: "veya.world.list" },
  ],
  [
    "veya.world.status",
    { method: "POST", path: "/v2/worlds/status", tool: "veya.world.status" },
  ],
  [
    "veya.world.read",
    { method: "POST", path: "/v2/worlds/read", tool: "veya.world.read" },
  ],
  [
    "veya.assets.list",
    { method: "POST", path: "/v2/assets/list", tool: "veya.assets.list" },
  ],
  [
    "veya.world.create",
    { method: "POST", path: "/v2/worlds/create", tool: "veya.world.create" },
  ],
  [
    "veya.world.copy",
    { method: "POST", path: "/v2/worlds/copy", tool: "veya.world.copy" },
  ],
  [
    "veya.world.validate",
    {
      method: "POST",
      path: "/v2/worlds/validate",
      tool: "veya.world.validate",
    },
  ],
  [
    "veya.world.apply",
    { method: "POST", path: "/v2/worlds/apply", tool: "veya.world.apply" },
  ],
  [
    "veya.travel.preload",
    { method: "POST", path: "/v2/travel/preload", tool: "veya.travel.preload" },
  ],
  [
    "veya.travel.enter",
    { method: "POST", path: "/v2/travel/enter", tool: "veya.travel.enter" },
  ],
  [
    "veya.operation.status",
    {
      method: "POST",
      path: "/v2/operations/status",
      tool: "veya.operation.status",
    },
  ],
  [
    "veya.operation.cancel",
    {
      method: "POST",
      path: "/v2/operations/cancel",
      tool: "veya.operation.cancel",
    },
  ],
  ["veya.preview.capture", { method: "POST", tool: "veya.preview.capture" }],
  [
    "veya.cooker.capabilities",
    { method: "POST", tool: "veya.cooker.capabilities" },
  ],
  ["veya.cooker.submit", { method: "POST", tool: "veya.cooker.submit" }],
  ["veya.atmosphere.build", { method: "POST", tool: "veya.atmosphere.build" }],
  ["veya.cooker.status", { method: "POST", tool: "veya.cooker.status" }],
  ["veya.cooker.cancel", { method: "POST", tool: "veya.cooker.cancel" }],
  ["veya.runtime.observe", { method: "POST", tool: "veya.runtime.observe" }],
  ["veya.runtime.inspect", { method: "POST", tool: "veya.runtime.inspect" }],
  ["veya.action.perform", { method: "POST", tool: "veya.action.perform" }],
  ["veya.dialogue.choose", { method: "POST", tool: "veya.dialogue.choose" }],
  ["veya.player.respawn", { method: "POST", tool: "veya.player.respawn" }],
]);

interface SessionDescriptor {
  baseUrl: string;
  token: string;
  toolsProtocol?: "veya-agent-tools/1";
  exchangeRoot?: string;
  previewRoot?: string;
  generationRoot?: string;
}

type Fetch = typeof fetch;

function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Veya World Agent input must be a JSON object.");
  return value;
}

function descriptor(value: unknown): SessionDescriptor {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Veya World Agent session descriptor is invalid.");
  const source = value as Record<string, unknown>;
  if (source.protocol !== "veya-world-http/1")
    throw new Error("Veya World Agent protocol is not supported.");
  if (typeof source.token !== "string" || !/^[0-9a-f]{64}$/u.test(source.token))
    throw new Error("Veya World Agent session token is invalid.");
  if (typeof source.base_url !== "string")
    throw new Error("Veya World Agent session URL is invalid.");
  if (
    source.tools_protocol !== undefined &&
    source.tools_protocol !== "veya-agent-tools/1"
  )
    throw new Error("Veya Agent tools protocol is not supported.");
  let url: URL;
  try {
    url = new URL(source.base_url);
  } catch {
    throw new Error("Veya World Agent session URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Veya World Agent session URL must be a loopback origin.");
  return {
    baseUrl: url.origin,
    token: source.token,
    ...(typeof source.generation_root === "string" &&
    isAbsolute(source.generation_root)
      ? { generationRoot: source.generation_root }
      : {}),
    ...(typeof source.exchange_root === "string" &&
    isAbsolute(source.exchange_root)
      ? { exchangeRoot: source.exchange_root }
      : {}),
    ...(typeof source.preview_root === "string" &&
    isAbsolute(source.preview_root)
      ? { previewRoot: source.preview_root }
      : {}),
    ...(source.tools_protocol === "veya-agent-tools/1"
      ? { toolsProtocol: source.tools_protocol }
      : {}),
  };
}

function responseObject(value: unknown): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Veya World Agent returned an invalid response.");
  return value as Record<string, JsonValue>;
}

/** Fixed-operation client. It never exposes the descriptor or bearer token. */
export class VeyaWorldAgentCapability implements AuraCapabilityClient {
  readonly sessionPath: string;
  readonly request: Fetch;
  readonly media?: {
    artifacts: GeneratedArtifacts;
    attachments: Pick<Context["attachments"], "saveImage">;
  };

  constructor(
    sessionPath: string,
    request: Fetch = fetch,
    media?: {
      artifacts: GeneratedArtifacts;
      attachments: Pick<Context["attachments"], "saveImage">;
    },
  ) {
    this.sessionPath = sessionPath;
    this.request = request;
    this.media = media;
  }

  private async session(): Promise<SessionDescriptor> {
    let content: string;
    try {
      content = await readFile(this.sessionPath, "utf8");
    } catch {
      throw new Error(
        "Veya World Agent is not running or its session descriptor is unavailable.",
      );
    }
    if (Buffer.byteLength(content) > 8_192)
      throw new Error("Veya World Agent session descriptor is too large.");
    try {
      return descriptor(JSON.parse(content) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("Veya World Agent session descriptor is invalid.");
      throw error;
    }
  }

  async invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const session = await this.session();
    if (capability === VEYA_WORLD_AGENT_CAPABILITY && this.media) {
      const body = object(input);
      const staged: { id: unknown; format: "glb" | "png" }[] =
        operation === "veya.assets.import" ? [{ id: body.artifact_id, format: "glb" }] : [];
      if (operation === "veya.atmosphere.build" && body.source === "ai_cloud")
        staged.push({ id: body.artifact_id, format: "png" });
      if (operation === "veya.cooker.submit" && Array.isArray(body.inputs))
        for (const item of body.inputs) {
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.source === "string" &&
            item.source.startsWith("artifact://")
          )
            staged.push({ id: item.source.slice("artifact://".length),
              format: typeof item.destination === "string" && item.destination.endsWith(".png") ? "png" : "glb" });
        }
      if (staged.length && !session.exchangeRoot)
        throw new ActionFailure(
          "asset_exchange_unavailable: Update Veya to support managed asset imports.",
        );
      for (const artifact of staged)
        if (artifact.format === "png")
          await this.media.artifacts.stageCloudPng(artifact.id, session.exchangeRoot!, signal);
        else
          await this.media.artifacts.stageModel(artifact.id, session.exchangeRoot!, signal);
    }
    const deadline = Date.now() + 10_000;
    let data: JsonValue;
    for (;;) {
      try {
        data = await this.invokeOnce(
          capability,
          operation,
          input,
          signal,
          session,
        );
        break;
      } catch (error) {
        if (
          operation !== "veya.preview.capture" ||
          !(error instanceof ActionFailure) ||
          !error.message.startsWith("Veya preview_not_ready ") ||
          Date.now() >= deadline
        )
          throw error;
        await delay(100, undefined, { signal });
      }
    }
    if (operation === "veya.preview.capture" && this.media) {
      const capture = object(data);
      if (
        !session.previewRoot ||
        typeof capture.capture_id !== "string" ||
        !/^[a-f0-9]{32}$/u.test(capture.capture_id) ||
        capture.mime_type !== "image/png"
      )
        throw new ActionFailure(
          "invalid_preview_reference: Veya did not return a managed PNG reference.",
        );
      // Never read the response's screenshot path. Derive the path solely from
      // the bound root and opaque capture ID, then verify the exact native bytes.
      const bytes = await readBoundedFile(
        join(session.previewRoot, `${capture.capture_id}.png`),
        32 * 1024 * 1024,
        signal,
        session.previewRoot,
      );
      if (
        bytes.length !== capture.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== capture.sha256
      )
        throw new ActionFailure(
          "preview_hash_mismatch: Screenshot bytes changed before attachment admission.",
        );
      const image = await this.media.attachments.saveImage({
        data: bytes,
        mediaType: "image/png",
        name: `veya-${capture.capture_id}.png`,
      });
      return { ...capture, image: image as unknown as JsonValue };
    }
    return data;
  }

  /** Trusted producer configuration; not an Agent filesystem operation. */
  async generatedOutputDirectory() {
    return (await this.session()).generationRoot;
  }

  private async invokeOnce(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
    session: SessionDescriptor,
  ): Promise<JsonValue> {
    if (capability !== VEYA_WORLD_AGENT_CAPABILITY)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    const route = operations.get(operation);
    if (!route)
      throw new Error(`Unsupported Veya World Agent operation: ${operation}`);
    const body = object(input);
    const useTools = Boolean(session?.toolsProtocol && route.tool);
    if (!useTools && !route.path)
      throw new Error(
        `Veya World Agent operation requires veya-agent-tools/1: ${operation}`,
      );
    const method = useTools ? "POST" : route.method;
    const path = useTools
      ? "/agent/v1/call"
      : session?.toolsProtocol && operation === "health"
        ? "/agent/v1/health"
        : route.path!;
    const payload =
      method === "POST"
        ? JSON.stringify(
            useTools ? { tool: route.tool!, arguments: body } : body,
          )
        : undefined;
    if (payload && Buffer.byteLength(payload) > 1024 * 1024)
      throw new Error("Veya World Agent request exceeds 1 MiB.");
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.request(`${session.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${session.token}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: payload } : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error("Veya World Agent connection failed.", { cause: error });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 2 * 1024 * 1024)
      throw new Error("Veya World Agent response exceeds 2 MiB.");
    let envelope: Record<string, JsonValue>;
    try {
      envelope = responseObject(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown,
      );
    } catch {
      throw new Error("Veya World Agent returned invalid JSON.");
    }
    if (response.ok && envelope.ok === true && "data" in envelope)
      return envelope.data ?? null;
    const code =
      typeof envelope.error === "string" ? envelope.error : "request_failed";
    // Only bounded domain codes cross the tool boundary. Native importer/VM
    // messages can contain private paths; never forward those verbatim.
    const safeCode = /^[a-z][a-z0-9_]{0,95}$/u.test(code)
      ? code
      : "validation_failed";
    const explanation =
      safeCode === "revision_conflict"
        ? " The world changed; read its latest revision before editing."
        : "";
    throw new ActionFailure(
      `Veya ${safeCode} (HTTP ${response.status}).${explanation}`,
    );
  }
}
