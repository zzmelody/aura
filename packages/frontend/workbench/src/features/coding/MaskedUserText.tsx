import React, { useSyncExternalStore } from "react";
import { useConversationMessages } from "../../conversation-messages.ts";
import {
  secretMaskSnapshot,
  subscribeSecretMask,
  secretSegments,
} from "./secret-mask.ts";

export function MaskedUserText({ text }: { text: string }) {
  const { t } = useConversationMessages();
  const mask = useSyncExternalStore(subscribeSecretMask, secretMaskSnapshot);
  // Fail closed while the native browser bundle is loading or failed.
  if (!mask) return <span title={t("maskLoading")}>{t("maskPending")}</span>;
  const Secret = mask.render;
  return (
    <span
      title={t("maskDisplayOnly")}
      onCopy={(event) => {
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      }}
    >
      {secretSegments(text, mask.rule).map((segment, index) =>
        segment.node ? (
          <Secret
            key={`${index}:${text}`}
            node={segment.node}
            raw={segment.text}
            interactive
            t={mask.translate}
          />
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </span>
  );
}
