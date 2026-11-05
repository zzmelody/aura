import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  parseStartupTiming,
  STARTUP_TIMING_PREFIX,
  type StartupTiming,
} from "./startup-timing.ts";

export const HOST_DIAGNOSTIC_PREFIX = "AURA_DSH_DIAGNOSTIC ";
const errorNames = new Set([
  "Error",
  "SyntaxError",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);
const reasons = new Set([
  "Expression expected",
  "Unexpected token",
  "Unexpected end of input",
  "Invalid TypeScript syntax",
  "Module not found",
  "Package export unavailable",
  "Required service unavailable",
  "Invalid property access",
  "Identifier is not defined",
  "Operation timed out",
  "Operation aborted",
  "Startup or activation failed",
  "Filesystem operation failed",
]);

export interface HostErrorDiagnostic {
  name: string;
  reason: string;
  code?: string;
  location?: string;
  module?: string;
  services?: string[];
}

/** Project metadata only: raw messages, source snippets and provider data stay private. */
export function hostErrorDiagnostic(error: unknown): HostErrorDiagnostic {
  const value = error instanceof Error ? error : undefined;
  const code = value && "code" in value ? value.code : undefined;
  const message = value?.message ?? "";
  let reason = "Startup or activation failed";
  if (/Expression expected/u.test(message)) reason = "Expression expected";
  else if (/Unexpected token/u.test(message)) reason = "Unexpected token";
  else if (/Unexpected end/u.test(message)) reason = "Unexpected end of input";
  else if (code === "ERR_INVALID_TYPESCRIPT_SYNTAX")
    reason = "Invalid TypeScript syntax";
  else if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    reason = "Module not found";
  else if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
    reason = "Package export unavailable";
  else if (
    ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(String(code))
  )
    reason = "Filesystem operation failed";
  else if (/cannot get (?:required service|property)/u.test(message))
    reason = "Required service unavailable";
  else if (/Cannot read properties|Cannot set properties/u.test(message))
    reason = "Invalid property access";
  else if (/is not defined/u.test(message))
    reason = "Identifier is not defined";
  else if (value?.name === "TimeoutError") reason = "Operation timed out";
  else if (value?.name === "AbortError") reason = "Operation aborted";
  const location = stripVTControlCharacters(value?.stack ?? "").match(
    /(?:file:\/\/\/|\/|[A-Za-z]:\\)[^\n\r()?#]*?\.(?:[cm]?[jt]sx?|json|ya?ml):\d+(?::\d+)?/u,
  )?.[0];
  return parseHostErrorDiagnostic({
    name: value?.name,
    reason,
    code,
    location,
    module: message.match(
      /Cannot find (?:package|module) ['"]([^'"]+)['"]/u,
    )?.[1],
  });
}

/** Keep wrapped filesystem/compiler causes without ever serializing Error objects. */
export function hostErrorDiagnostics(error: unknown): HostErrorDiagnostic[] {
  const results: HostErrorDiagnostic[] = [];
  const seen = new Set<Error>();
  const visit = (value: unknown) => {
    if (!(value instanceof Error) || seen.has(value) || results.length >= 5)
      return;
    seen.add(value);
    results.push(hostErrorDiagnostic(value));
    visit(value.cause);
    if (value instanceof AggregateError)
      for (const cause of value.errors as unknown[]) visit(cause);
  };
  visit(error);
  return results.length ? results : [hostErrorDiagnostic(error)];
}

/** Validate again in the parent: a child cannot smuggle arbitrary stderr into logs. */
export function parseHostErrorDiagnostic(source: unknown): HostErrorDiagnostic {
  const value = source as Record<string, unknown> | null;
  const name =
    typeof value?.name === "string" && errorNames.has(value.name)
      ? value.name
      : "Error";
  const reason =
    typeof value?.reason === "string" && reasons.has(value.reason)
      ? value.reason
      : "Startup or activation failed";
  const code =
    typeof value?.code === "string" &&
    /^(?:ERR_[A-Z_]{1,64}|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|EADDRINUSE)$/u.test(
      value.code,
    )
      ? value.code
      : undefined;
  const location =
    typeof value?.location === "string" &&
    /^(?:file:\/\/\/|\/|[A-Za-z]:\\)[^\n\r()?#]{1,1000}\.(?:[cm]?[jt]sx?|json|ya?ml):\d+(?::\d+)?$/u.test(
      value.location,
    )
      ? value.location
      : undefined;
  const module =
    typeof value?.module === "string" &&
    /^(?:@?[a-zA-Z0-9_.-]+|\.{1,2}\/|\/|[A-Za-z]:\\)[a-zA-Z0-9_./\\ @+-]{0,500}$/u.test(
      value.module,
    )
      ? value.module
      : undefined;
  const services = Array.isArray(value?.services)
    ? value.services
        .filter(
          (service): service is string =>
            typeof service === "string" &&
            /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/u.test(service),
        )
        .slice(0, 32)
    : [];
  return {
    name,
    reason,
    ...(code ? { code } : {}),
    ...(location ? { location } : {}),
    ...(module ? { module } : {}),
    ...(services.length ? { services } : {}),
  };
}

/** Bounded line parsing; raw stderr is never printed or persisted. */
export class HostDiagnosticReader {
  private pending = "";
  private readonly report: (error: HostErrorDiagnostic) => void;
  private readonly unavailable: () => void;
  private readonly timing?: (timing: StartupTiming) => void;
  constructor(
    report: (error: HostErrorDiagnostic) => void,
    unavailable: () => void,
    timing?: (timing: StartupTiming) => void,
  ) {
    this.report = report;
    this.unavailable = unavailable;
    this.timing = timing;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = stripVTControlCharacters(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
      if (line.startsWith(STARTUP_TIMING_PREFIX) && line.length <= 1024) {
        try {
          const timing = parseStartupTiming(
            JSON.parse(line.slice(STARTUP_TIMING_PREFIX.length)),
          );
          if (timing) this.timing?.(timing);
        } catch {
          // Ignore malformed child output.
        }
      }
      if (line.startsWith(HOST_DIAGNOSTIC_PREFIX) && line.length <= 4096) {
        try {
          this.report(
            parseHostErrorDiagnostic(
              JSON.parse(line.slice(HOST_DIAGNOSTIC_PREFIX.length)),
            ),
          );
        } catch {
          /* Ignore malformed child output. */
        }
      }
      if (
        /^aura-orchestration \([^\n]+\): (?:failed to import|pending \(waiting for services?:)/u.test(
          line,
        )
      ) {
        const services = line
          .match(/pending \(waiting for services?: ([^)]+)\)/u)?.[1]
          .split(/,\s*/u);
        if (services)
          this.report(
            parseHostErrorDiagnostic({
              reason: "Required service unavailable",
              services,
            }),
          );
        this.unavailable();
      }
    }
    if (this.pending.length > 16_384) this.pending = "";
  }
}

/** Sanitized terminal and rotating local diagnostics, serialized across startup attempts. */
export class HostLogger {
  private writing = Promise.resolve();
  private readonly dshHome: string;
  constructor(dshHome: string) {
    this.dshHome = dshHome;
  }

  write(event: string, error?: HostErrorDiagnostic): void {
    this.append({
      time: new Date().toISOString(),
      event,
      ...(error ? { error } : {}),
    });
  }

  writeStartup(value: StartupTiming): void {
    const timing = parseStartupTiming(value);
    if (timing)
      this.append({
        time: new Date().toISOString(),
        event: "startup",
        ...timing,
      });
  }

  private append(record: object): void {
    const line = JSON.stringify(record);
    console.error("[Aura DSH]", line);
    this.writing = this.writing
      .then(async () => {
        const directory = join(this.dshHome, "logs");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, "aura-host.log");
        const size = await stat(path)
          .then((info) => info.size)
          .catch(() => 0);
        if (size >= 1_048_576) await rename(path, `${path}.1`);
        await appendFile(path, `${line}\n`, { mode: 0o600 });
      })
      .catch(() =>
        console.error("[Aura DSH] Could not write the local diagnostic log."),
      );
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
