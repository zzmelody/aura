import { readFile } from "node:fs/promises";
import type { JsonValue } from "@aura/protocol/types";
import type { AuraCapabilityClient } from "./action-api.ts";

export const VEYA_WORLD_AGENT_CAPABILITY = "aura.veya.world-agent";

type Operation = { method: "GET" | "POST"; path?: string; tool?: string };

const operations = new Map<string, Operation>([
  ["health", { method: "GET", path: "/v1/health" }],
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
]);

interface SessionDescriptor {
  baseUrl: string;
  token: string;
  toolsProtocol?: "veya-agent-tools/1";
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

  constructor(sessionPath: string, request: Fetch = fetch) {
    this.sessionPath = sessionPath;
    this.request = request;
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
    if (capability !== VEYA_WORLD_AGENT_CAPABILITY)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    const route = operations.get(operation);
    if (!route)
      throw new Error(`Unsupported Veya World Agent operation: ${operation}`);
    const body = object(input);
    const session = await this.session();
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
    const message =
      typeof envelope.message === "string"
        ? envelope.message
        : `HTTP ${response.status}`;
    throw new Error(`Veya World Agent ${code}: ${message}`);
  }
}
