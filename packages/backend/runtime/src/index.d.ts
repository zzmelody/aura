export interface AuraRuntimeOptions {
  root?: string;
  host?: string;
  port?: number;
}

export interface AuraRuntimeHandle {
  url: string;
  close(): Promise<void>;
}

export declare function startAuraRuntime(
  options?: AuraRuntimeOptions,
): Promise<AuraRuntimeHandle>;

export declare function readJson(
  request: Readable,
  limit?: number,
): Promise<unknown>;
import type { Readable } from "node:stream";
