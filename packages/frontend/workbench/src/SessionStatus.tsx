import React from "react";
import {
  Check,
  CircleAlert,
  CircleDashed,
  Clock3,
  LoaderCircle,
  MessageCircleQuestion,
  Pause,
  Square,
} from "lucide-react";
import type { SessionStatus as Status } from "./sidebarSessions";

const icons = {
  idle: CircleDashed,
  running: LoaderCircle,
  queued: Clock3,
  completed: Check,
  stopped: Square,
  failed: CircleAlert,
  paused: Pause,
  attention: CircleAlert,
  waiting: MessageCircleQuestion,
};

export function SessionStatus({
  status,
  text = false,
}: {
  status: Status;
  text?: boolean;
}) {
  const Icon = icons[status.kind];
  return (
    <span
      className={`session-execution-status ${status.kind}${text ? " with-label" : ""}`}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      <Icon size={13} aria-hidden="true" />
      {text ? <span aria-hidden="true">{status.label}</span> : null}
    </span>
  );
}
