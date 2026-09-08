import type { Readable } from "node:stream";

export declare function readJson(
  request: Readable,
  limit?: number,
): Promise<unknown>;
