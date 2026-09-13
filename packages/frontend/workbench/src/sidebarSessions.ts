import type { Session } from "@aura/core/types";

export function sidebarSessionTitle(session: Session): string {
  if (!session.workflow || session.title !== session.workflow.title)
    return session.title;
  let text =
    session.messages.find((message) => message.role === "user")?.text.trim() ??
    "";
  if (text.startsWith("{")) {
    try {
      const input: unknown = JSON.parse(text);
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const prompt = Object.values(input).find(
          (value) => typeof value === "string" && value.trim(),
        );
        if (typeof prompt === "string") text = prompt;
      }
    } catch {
      /* Truncated legacy previews remain searchable as plain text. */
    }
  }
  return text.replace(/\s+/g, " ").slice(0, 80) || "新的运行";
}

export function groupSidebarSessions(sessions: Session[]) {
  const groups = new Map<
    string,
    { id: string; title: string; workflow: boolean; sessions: Session[] }
  >();
  for (const session of sessions) {
    const id = session.workflow
      ? JSON.stringify([session.workflow.endpoint, session.workflow.id])
      : "chat";
    const group = groups.get(id) ?? {
      id,
      title: session.workflow?.title ?? "对话",
      workflow: Boolean(session.workflow),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return [...groups.values()];
}
