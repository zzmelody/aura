/// <reference types="vite/client" />
import { registerCatalogs, MessageError } from "@aura/i18n/runtime";
import { isNativeFailure, type NativeFailure } from "@aura/protocol/native-ui";
import zh from "./locales/zh-CN/native.json" with { type: "json" };
import en from "./locales/en/native.json" with { type: "json" };
import ja from "./locales/ja/native.json" with { type: "json" };
import ko from "./locales/ko/native.json" with { type: "json" };
import ru from "./locales/ru/native.json" with { type: "json" };
import fr from "./locales/fr/native.json" with { type: "json" };

const dispose = registerCatalogs("native", { "zh-CN": zh, en, ja, ko, ru, fr });
if (import.meta.hot) import.meta.hot.dispose(dispose);

/** Public UI adapters keep Promise<T>/Error while the private bridge returns safe DTOs. */
export async function nativeCall<Value>(
  operation: () => Promise<Value | NativeFailure>,
): Promise<Value> {
  const result = await operation();
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === "aura.native.failure"
  )
    throw new MessageError({
      namespace: "native",
      key: isNativeFailure(result) ? result.code : "operationFailed",
    });
  return result as Value;
}
