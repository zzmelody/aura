import React from "react";

/** A quiet living orb; the shell's reduced-motion preference freezes it. */
export function AuraAssistantIcon({ running = false }: { running?: boolean }) {
  return (
    <span
      className="aura-assistant-orb"
      data-running={running || undefined}
      aria-hidden="true"
    >
      <span className="aura-assistant-halo" />
      <span className="aura-assistant-orbit">
        <span />
      </span>
      <span className="aura-assistant-core" />
    </span>
  );
}
