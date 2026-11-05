import type { Context, Message } from "@deepseek-ai/cordis";
import {
  HOST_DIAGNOSTIC_PREFIX,
  hostErrorDiagnostics,
} from "./host-diagnostics.ts";

export const name = "aura-host-diagnostics";

/** The public Cordis exporter also sees import errors before Aura can activate. */
export function apply(ctx: Context): void {
  const report = (message: Message) => {
    if (message.type !== "error") return;
    for (const argument of message.args as unknown[]) {
      if (!(argument instanceof Error)) continue;
      for (const error of hostErrorDiagnostics(argument))
        process.stderr.write(
          `${HOST_DIAGNOSTIC_PREFIX}${JSON.stringify(error)}\n`,
        );
    }
  };
  // The loader imports siblings concurrently; recover earlier errors from its buffer.
  for (const message of ctx.logger.buffer) report(message);
  ctx.logger.exporter({ export: report });
}
