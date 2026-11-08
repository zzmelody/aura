/// <reference types="vite/client" />
import href from "@deepseek-ai/dsh-client-ui-secret-mask/client?url&no-inline";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { loadLocalClientBundle } from "../../client-bundle-loader.ts";
import { SECRET_MASK_MODULE, type SecretMaskPlugin } from "./secret-mask.ts";

export async function loadSecretMaskClient(
  signal: AbortSignal,
): Promise<SecretMaskPlugin> {
  const bundle = await loadLocalClientBundle(href, SECRET_MASK_MODULE, signal);
  const value = bundle.factory((specifier) => {
    if (specifier === "react") return React;
    if (specifier === "react/jsx-runtime") return jsxRuntime;
    throw new Error("Unsupported secret mask dependency.");
  });
  if (
    !value ||
    typeof value !== "object" ||
    !("apply" in value) ||
    typeof value.apply !== "function"
  )
    throw new Error("The secret mask client did not export apply.");
  return value as SecretMaskPlugin;
}
