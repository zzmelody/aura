/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import {
  language,
  registerCatalogs,
  type MessageReference,
} from "@aura/i18n/runtime";
import c0 from "./locales/zh-CN/conversation.json" with { type: "json" };
import c1 from "./locales/en/conversation.json" with { type: "json" };
import c2 from "./locales/ja/conversation.json" with { type: "json" };
import c3 from "./locales/ko/conversation.json" with { type: "json" };
import c4 from "./locales/ru/conversation.json" with { type: "json" };
import c5 from "./locales/fr/conversation.json" with { type: "json" };
const dispose = registerCatalogs("conversation", {
  "zh-CN": c0,
  en: c1,
  ja: c2,
  ko: c3,
  ru: c4,
  fr: c5,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
export type ConversationMessageKey = keyof typeof c1;
export function conversationText(key: ConversationMessageKey): string {
  return language.i18n.t(key, { ns: "conversation" });
}
export function useConversationMessages() {
  return useMessages<ConversationMessageKey>("conversation");
}
export function conversationMessage(
  key: ConversationMessageKey,
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "conversation", key, ...(values ? { values } : {}) };
}
