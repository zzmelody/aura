// @ts-check
import { defineCapability } from "@aura/plugin-sdk/capability";
import { describeProject, SiteRunner } from "../../backend/dist/site-runner.js";

/** @param {unknown} value @returns {import("@aura/protocol/types").JsonValue} */
function json(value) {
  return JSON.parse(JSON.stringify(value));
}

export default defineCapability({
  title: "本地站点运行器",
  open() {
    let closed = false;
    const runner = new SiteRunner({
      onStatus() {},
      async openPreview() {},
    });
    return {
      pageOperations: ["describe", "start", "stop", "status", "open"],
      async invoke(operation, input, call) {
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
      },
      async close() {
        closed = true;
        await runner.stop();
      },
    };
  },
});
