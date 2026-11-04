import React, { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Database, GitFork } from "lucide-react";
import type { CodingTurnUsage } from "@aura/protocol/types";
import { writeClipboard } from "../../clipboard.ts";
import { Tooltip } from "../../Tooltip.tsx";
import { useToast } from "../../toast.tsx";
import { useAnchoredPopover } from "../../useAnchoredPopover.ts";

const compactCount = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactCount = new Intl.NumberFormat("zh-CN");
const timeOfDay = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const monthDay = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});
const fullDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

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
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const resetCopy = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(resetCopy.current), []);
  if (!reply.trim() && !onFork && !usage) return null;
  const copyLabel = copied ? "已复制本轮回复" : "复制本轮回复";
  const copy = async () => {
    try {
      await writeClipboard(reply);
      setCopied(true);
      window.clearTimeout(resetCopy.current);
      resetCopy.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ message: "复制失败，请重试" });
    }
  };
  return (
    <div className="coding-turn-actions" role="group" aria-label="本轮回复操作">
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
      <Tooltip
        label={onFork ? "分叉到新对话" : "这条回复暂不可分叉"}
        delayMs={0}
      >
        <button
          type="button"
          className="icon-control"
          aria-label="分叉到新对话"
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
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const clock = timeOfDay.format(date);
  const day =
    date.toDateString() === now.toDateString()
      ? ""
      : (date.getFullYear() === now.getFullYear() ? monthDay : fullDate).format(
          date,
        );
  return (
    <time dateTime={date.toISOString()}>{day ? `${day} ${clock}` : clock}</time>
  );
}

function TurnUsage({ usage }: { usage: CodingTurnUsage }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useAnchoredPopover(open, trigger, panel, { align: "start" });
  const promptTokens = usage.totalTokens - usage.outputTokens;
  const cacheHit =
    usage.cacheReadTokens !== undefined && promptTokens > 0
      ? `${((usage.cacheReadTokens / promptTokens) * 100).toFixed(1)}%`
      : undefined;
  const rows = [
    ["缓存命中率", cacheHit],
    ["未缓存输入", tokenLabel(usage.uncachedInputTokens)],
    ["缓存读取", tokenLabel(usage.cacheReadTokens)],
    ["缓存写入", tokenLabel(usage.cacheWriteTokens)],
    ["输出", tokenLabel(usage.outputTokens)],
    ["推理（计入输出）", tokenLabel(usage.reasoningTokens)],
  ] as const;
  return (
    <div className="coding-turn-usage">
      <button
        type="button"
        ref={trigger}
        className="coding-usage-trigger"
        aria-label={`本轮用量 ${exactCount.format(usage.totalTokens)} tok`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Database size={15} aria-hidden="true" />
        <span>用量 {compactCount.format(usage.totalTokens)} tok</span>
      </button>
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-label="本轮 Token 用量"
        popover="auto"
        className="coding-usage-panel"
        onToggle={(event) => {
          if (!event.currentTarget.matches(":popover-open")) setOpen(false);
        }}
      >
        <div className="coding-usage-heading">
          <span>
            <Database size={14} aria-hidden="true" />
            本轮用量
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
  return count === undefined ? undefined : `${exactCount.format(count)} tok`;
}
