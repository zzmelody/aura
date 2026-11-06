const simpleCodes = [
  "checkingPorts",
  "startFailed",
  "previewFailed",
  "stoppingProject",
  "stopFailed",
  "projectStopped",
  "processEnded",
  "processExited",
  "openingPreview",
  "previewOpened",
  "previewTimeout",
  "directoryAbsolute",
  "directoryMissing",
  "manifestUnavailable",
  "manifestInvalid",
  "scriptsMissing",
  "directoryRequired",
  "scriptMissing",
  "invalidPreviewUrl",
  "previewNotReady",
] as const;
export type SiteMessage =
  | { code: (typeof simpleCodes)[number] }
  | { code: "portOccupied" | "noFreePort"; params: { port: number } }
  | { code: "portChanged"; params: { preferred: number; port: number } }
  | { code: "addressChanged"; params: { url: string; previous: string } }
  | { code: "runningScript"; params: { manager: string; script: string } }
  | { code: "processExitCode"; params: { exitCode: number } }
  | { code: "processExitSignal"; params: { signal: string } };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const port = (value: unknown): value is number => integer(value, 1, 65535);
const localUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/** Literal script/URL values remain unchanged; arbitrary diagnostics never become parameters. */
export function readSiteMessage(value: unknown): SiteMessage | undefined {
  if (!record(value)) return;
  const { code, params } = value;
  const simple = simpleCodes.find((item) => item === code);
  if (simple) return { code: simple };
  if (!record(params)) return;
  if ((code === "portOccupied" || code === "noFreePort") && port(params.port))
    return { code, params: { port: params.port } };
  if (code === "portChanged" && port(params.preferred) && port(params.port))
    return { code, params: { preferred: params.preferred, port: params.port } };
  if (
    code === "addressChanged" &&
    localUrl(params.url) &&
    localUrl(params.previous)
  )
    return { code, params: { url: params.url, previous: params.previous } };
  if (
    code === "runningScript" &&
    typeof params.manager === "string" &&
    ["pnpm", "npm", "yarn", "bun"].includes(params.manager) &&
    typeof params.script === "string" &&
    /^[a-zA-Z0-9:_-]{1,1024}$/u.test(params.script)
  )
    return { code, params: { manager: params.manager, script: params.script } };
  if (
    code === "processExitCode" &&
    integer(params.exitCode, -2147483648, 4294967295)
  )
    return { code, params: { exitCode: params.exitCode } };
  if (
    code === "processExitSignal" &&
    typeof params.signal === "string" &&
    /^SIG[A-Z0-9]{1,20}$/u.test(params.signal)
  )
    return { code, params: { signal: params.signal } };
}

/** Backend errors retain their legacy message while carrying a display-only reason. */
export class SiteStatusError extends Error {
  readonly details: SiteMessage;
  constructor(message: string, details: SiteMessage) {
    super(message);
    this.name = "SiteStatusError";
    this.details = details;
  }
}
