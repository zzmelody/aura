import React, { useSyncExternalStore } from "react";
import {
  secretMaskSnapshot,
  subscribeSecretMask,
  secretSegments,
} from "./secret-mask.ts";

export function MaskedUserText({ text }: { text: string }) {
  const mask = useSyncExternalStore(subscribeSecretMask, secretMaskSnapshot);
  // Fail closed while the native browser bundle is loading or failed.
  if (!mask) return <span title="正在加载 DSH 密钥遮罩">用户消息暂未显示</span>;
  const Secret = mask.render;
  return (
    <span
      title="密钥遮罩仅影响显示；模型输入、历史记录和复制仍保留原文。"
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
