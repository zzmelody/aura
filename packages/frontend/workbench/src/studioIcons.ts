import {
  ChartCandlestick,
  Clapperboard,
  FlaskConical,
  MessageCircle,
  MessageSquare,
  Newspaper,
  PanelsTopLeft,
  Puzzle,
  Telescope,
} from "lucide-react";

const icons: Record<string, typeof Puzzle> = {
  ChartCandlestick,
  Clapperboard,
  FlaskConical,
  MessageCircle,
  MessageSquare,
  Newspaper,
  PanelsTopLeft,
  Telescope,
};

/** Plugins name lucide icons in either PascalCase or kebab-case. */
export function studioIcon(name?: string): typeof Puzzle {
  if (!name) return Puzzle;
  const pascal = name.replace(/(?:^|-)([a-z0-9])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
  return icons[pascal] ?? Puzzle;
}
