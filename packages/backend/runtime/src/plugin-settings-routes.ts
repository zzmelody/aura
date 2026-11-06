import { AuraPluginConfigurationError } from "@aura/plugin-manager";
import { readErrorDetails } from "@aura/protocol/errors";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuraPluginSettingsPort } from "./types.ts";

/** Plugin configuration is code-execution authority, so LAN-bound runtimes deny it. */
export function createPluginSettingsApp(
  settings: AuraPluginSettingsPort,
  accessible: boolean,
) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (!accessible)
      return context.json(
        {
          message: "外部插件只能通过仅绑定本机的 Aura 服务配置。",
          code: "plugin_settings_local_only",
        },
        403,
      );
    await next();
  });

  app.get("/", async (context) => {
    try {
      return context.json(await settings.settings());
    } catch (error) {
      if (error instanceof AuraPluginConfigurationError)
        return context.json(
          { message: error.message, ...readErrorDetails(error.details) },
          409,
        );
      throw error;
    }
  });

  app.post(
    "/",
    bodyLimit({
      maxSize: 64 * 1_024,
      onError: (context) =>
        context.json(
          { message: "插件目录设置过大。", code: "plugin_settings_too_large" },
          413,
        ),
    }),
    async (context) => {
      try {
        const source = await context.req.json().catch(() => undefined);
        if (source === undefined)
          throw new AuraPluginConfigurationError(
            "插件目录设置不是有效 JSON。",
            { code: "plugin_json_invalid" },
          );
        return context.json(await settings.updateSettings(source as unknown));
      } catch (error) {
        if (error instanceof AuraPluginConfigurationError)
          return context.json(
            { message: error.message, ...readErrorDetails(error.details) },
            400,
          );
        throw error;
      }
    },
  );

  return app;
}
