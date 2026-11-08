import React, { useSyncExternalStore } from "react";
import { useConversationMessages } from "../../conversation-messages.ts";
import {
  secretMaskStateSnapshot,
  retrySecretMask,
  subscribeSecretMask,
  secretSegments,
} from "./secret-mask.ts";

export function MaskedUserText({ text }: { text: string }) {
  const { t } = useConversationMessages();
  const state = useSyncExternalStore(
    subscribeSecretMask,
    secretMaskStateSnapshot,
  );
  const mask = state.mask;
  if (!mask)
    return state.phase === "failed" ? (
      <span className="coding-mask-status" role="alert">
        <span>{t("maskFailed")}</span>
        <button
          type="button"
          className="tool-button"
          onClick={() => {
            void retrySecretMask();
          }}
        >
          {t("maskRetry")}
        </button>
      </span>
    ) : (
      <span role="status" aria-busy="true">
        {t("maskLoading")}
      </span>
    );
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
