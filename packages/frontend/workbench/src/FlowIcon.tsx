import { createLucideIcon } from "lucide-react";

/**
 * Workflow glyph: a start node, a flowing S-path, and an end node.
 * Built with createLucideIcon so it accepts the same props (size, strokeWidth,
 * className, aria-*) as the lucide icons used everywhere else.
 */
export const FlowIcon = createLucideIcon("aura-flow", [
  [
    "rect",
    { x: "2", y: "2", width: "6", height: "6", rx: "1.5", key: "start" },
  ],
  [
    "path",
    { d: "M8 5h4.5a3.5 3.5 0 0 1 0 7h-1a3.5 3.5 0 0 0 0 7H16", key: "path" },
  ],
  ["circle", { cx: "19", cy: "19", r: "3", key: "end" }],
]);
