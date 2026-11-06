import { defineBackend } from "@aura/plugin-sdk/backend";
import { PluginFailure } from "@aura/plugin-sdk/errors";
import { siteErrorMessages } from "./error-messages.ts";
import type { JsonValue } from "@aura/protocol/types";
import { describeProject, SiteRunner } from "./site-runner.ts";

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export default defineBackend({
  open() {
    let closed = false;
    const runner = new SiteRunner({
      onStatus() {},
      async openPreview() {},
    });
    return {
      pageOperations: ["describe", "start", "stop", "status", "open"],
      async invoke(operation, input, call) {
        try {
          call.signal.throwIfAborted();
          if (closed) {
            throw new Error("site_runner_closed");
          }
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new Error("invalid_site_input");
          }
          if (operation === "describe") {
            if (typeof input.directory !== "string") {
              throw new Error("invalid_site_directory");
            }
            return json(await describeProject(input.directory));
          }
          if (operation === "start") {
            return json(await runner.start(input));
          }
          if (operation === "stop") {
            if (typeof input.id !== "string") {
              throw new Error("invalid_site_id");
            }
            return json(await runner.stop(input.id));
          }
          if (operation === "status") {
            return json(
              runner
                .getStatuses()
                .slice(-64)
                .map((status) => ({
                  ...status,
                  output: status.output?.slice(-2048),
                })),
            );
          }
          if (operation === "open") {
            if (typeof input.id !== "string") {
              throw new Error("invalid_site_id");
            }
            const status = runner.getStatus(input.id);
            if (!status.project) {
              throw new Error("site_not_running");
            }
            await runner.open(status.project);
            return json(status.project);
          }
          throw new Error("site_operation_forbidden");
        } catch (error) {
          const translations = siteErrorMessages(error);
          if (translations)
            throw new PluginFailure("page_operation_failed", translations, 422);
          throw error;
        }
      },
      async close() {
        closed = true;
        await runner.stop();
      },
    };
  },
});
