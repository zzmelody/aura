import type React from "react";
import { CONVERSATION_BOUNDS } from "./split-layout";
import { useContainerWidth, usePaneSplit } from "../../usePaneSplit.ts";
import { useToolMessages } from "../../tool-messages";

const STORAGE_KEY = "aura.coding.side-width";

/** A bounded, keyboard-accessible split; resizing never remounts either chat. */
export function ConversationSplit({
  main,
  side,
  sideVisible = !!side,
  hidden = false,
  mainHeader,
  sideHeader,
}: {
  main: React.ReactNode;
  side?: React.ReactNode;
  /** Hidden side chats stay mounted without reserving width or a divider. */
  sideVisible?: boolean;
  /** Another view covers the panes; they stay mounted so streams continue. */
  hidden?: boolean;
  mainHeader?: React.ReactNode;
  sideHeader?: React.ReactNode;
}) {
  const { t } = useToolMessages();
  const { ref: root, width: containerWidth } =
    useContainerWidth<HTMLDivElement>();
  const { width, stacked, resizing, handle } = usePaneSplit({
    storageKey: STORAGE_KEY,
    bounds: CONVERSATION_BOUNDS,
    containerWidth,
    active: sideVisible && !hidden,
    labels: {
      label: t("resizeConversationSplit"),
      hint: t("resizeHint"),
      valueText: (value) => t("toolPanelWidth", { width: value }),
    },
  });
  return (
    <div
      ref={root}
      className="coding-panes"
      hidden={hidden}
      data-stacked={stacked || undefined}
      data-tools-only={(sideVisible && stacked && !!sideHeader) || undefined}
      data-side-closed={!sideVisible || undefined}
      data-resizing={resizing || undefined}
      style={
        {
          "--coding-side-width": `${containerWidth ? width : 0}px`,
        } as React.CSSProperties
      }
    >
      {mainHeader ? (
        <div
          className="coding-pane coding-main-column"
          inert={sideVisible && stacked && !!sideHeader}
        >
          {mainHeader}
          {main}
        </div>
      ) : (
        main
      )}
      {side ? (
        <>
          {!stacked ? (
            <div
              className="coding-split-handle"
              inert={!sideVisible}
              {...handle}
            />
          ) : null}
          {sideHeader ? (
            <aside
              className="coding-side"
              aria-label={t("toolPanel")}
              inert={!sideVisible}
            >
              {sideHeader}
              {side}
            </aside>
          ) : (
            side
          )}
        </>
      ) : null}
    </div>
  );
}
