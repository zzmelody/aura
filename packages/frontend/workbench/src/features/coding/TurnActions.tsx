import {
  useConversationMessages,
  conversationMessage,
} from "../../conversation-messages.ts";
import { formatDate, formatNumber } from "@aura/i18n/runtime";
import React, { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Database, GitFork } from "lucide-react";
import type { CodingTurnUsage } from "@aura/protocol/types";
import { writeClipboard } from "../../clipboard.ts";
import { Tooltip } from "../../Tooltip.tsx";
import { useToast } from "../../toast.tsx";
import { useAnchoredPopover } from "../../useAnchoredPopover.ts";

export function TurnActions({
  reply,
  endedAt,
  usage,
  onFork,
}: {
  reply: string;
  endedAt?: number;
  usage?: CodingTurnUsage;
  onFork?(): void;
}) {
  const { t } = useConversationMessages();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const resetCopy = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(resetCopy.current), []);
  if (!reply.trim() && !onFork && !usage) return null;
  const copyLabel = copied ? t("turnCopied") : t("copyTurn");
  const copy = async () => {
    try {
      await writeClipboard(reply);
      setCopied(true);
      window.clearTimeout(resetCopy.current);
      resetCopy.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ message: conversationMessage("copyFailed") });
    }
  };
  return (
    <div
      className="coding-turn-actions"
      role="group"
      aria-label={t("turnActions")}
    >
      {reply.trim() ? (
        <Tooltip label={copyLabel} delayMs={0}>
          <button
            type="button"
            className="icon-control"
            aria-label={copyLabel}
            onClick={() => void copy()}
          >
            {copied ? (
              <Check size={17} aria-hidden="true" />
            ) : (
              <Copy size={17} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={onFork ? t("fork") : t("cannotFork")} delayMs={0}>
        <button
          type="button"
          className="icon-control"
          aria-label={t("fork")}
          aria-disabled={onFork ? undefined : true}
          onClick={onFork}
        >
          <GitFork size={17} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="coding-turn-metadata">
        {usage ? <TurnUsage usage={usage} /> : null}
        {endedAt !== undefined ? <TurnClock time={endedAt} /> : null}
      </div>
    </div>
  );
}

function TurnClock({ time }: { time: number }) {
  useConversationMessages();
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const label = formatDate(date, {
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay
      ? {}
      : {
          month: "numeric",
          day: "numeric",
          ...(date.getFullYear() === now.getFullYear()
            ? {}
            : { year: "numeric" }),
        }),
  });
  return <time dateTime={date.toISOString()}>{label}</time>;
}

function TurnUsage({ usage }: { usage: CodingTurnUsage }) {
  const { t } = useConversationMessages();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useAnchoredPopover(open, trigger, panel, { align: "start" });
  const promptTokens = usage.totalTokens - usage.outputTokens;
  const cacheHit =
    usage.cacheReadTokens !== undefined && promptTokens > 0
      ? formatNumber(usage.cacheReadTokens / promptTokens, {
          style: "percent",
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : undefined;
  const rows = [
    [t("cacheHit"), cacheHit],
    [t("uncachedInput"), tokenLabel(usage.uncachedInputTokens)],
    [t("cacheRead"), tokenLabel(usage.cacheReadTokens)],
    [t("cacheWrite"), tokenLabel(usage.cacheWriteTokens)],
    [t("output"), tokenLabel(usage.outputTokens)],
    [t("reasoningOutput"), tokenLabel(usage.reasoningTokens)],
  ] as const;
  return (
    <div className="coding-turn-usage">
      <button
        type="button"
        ref={trigger}
        className="coding-usage-trigger"
        aria-label={t("turnUsageLabel", { count: usage.totalTokens })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Database size={15} aria-hidden="true" />
        <span>
          {t("usageCount", {
            formatted: formatNumber(usage.totalTokens, {
              notation: "compact",
              maximumFractionDigits: 1,
            }),
          })}
        </span>
      </button>
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-label={t("turnTokens")}
        popover="auto"
        className="coding-usage-panel"
        onToggle={(event) => {
          if (!event.currentTarget.matches(":popover-open")) setOpen(false);
        }}
      >
        <div className="coding-usage-heading">
          <span>
            <Database size={14} aria-hidden="true" />
            {t("turnUsage")}
          </span>
          <strong>{tokenLabel(usage.totalTokens)}</strong>
        </div>
        <dl>
          {rows.map(([label, value]) =>
            value === undefined ? null : (
              <React.Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </React.Fragment>
            ),
          )}
        </dl>
      </div>
    </div>
  );
}

function tokenLabel(count: number | undefined): string | undefined {
  return count === undefined ? undefined : `${formatNumber(count)} tok`;
}
