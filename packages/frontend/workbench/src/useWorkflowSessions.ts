import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  useWorkflowMessages,
  workflowMessage as message,
} from "./workflow-messages";
import { workflowRuns } from "./workflow-run-store";
import { retainConversations } from "./features/coding/conversation-cache";
import type { Workspace, Message, Session } from "@aura/core/types";
import type {
  FlowCatalogEntry,
  FlowMode,
  FlowRun,
  FlowRunSummary,
  JsonValue,
} from "@aura/protocol/types";
import {
  applyWorkflowRun,
  isWorkflowOpen,
  mergeWorkflowRuns,
  messageEndpoint,
  workflowApi,
  workflowRunKey,
  WorkflowApiError,
} from "./workflowSessions";

export function useWorkflowSessions(
  state: Workspace,
  setState: Dispatch<SetStateAction<Workspace>>,
  ready: boolean,
) {
  const { i18n } = useWorkflowMessages();
  const stateRef = useRef(state);
  stateRef.current = state;
  const endpoint = state.endpoint || "http://127.0.0.1:4311";
  const [runs, setRuns] = useState<Record<string, FlowRun>>({});
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [errors, setErrors] = useState<
    Record<string, string | MessageReference>
  >({});
  const submittingRef = useRef(new Set<string>());
  const receive = useCallback(
    (source: string, run: FlowRun) => {
      workflowRuns.publish(source, run);
      setRuns((current) =>
        current[workflowRunKey(source, run.id)] === run
          ? current
          : retainConversations(
              {
                ...current,
                [workflowRunKey(source, run.id)]: run,
              },
              workflowRunKey(source, run.id),
              Object.entries(current)
                .filter(([, value]) => isWorkflowOpen(value.status))
                .map(([key]) => key),
              50,
            ),
      );
      setState((current) => applyWorkflowRun(current, source, run));
    },
    [setState],
  );
  const activeRuns = state.sessions
    .flatMap((session) =>
      session.messages.flatMap((message) => {
        const source = messageEndpoint(session, message);
        return message.workflowRunId &&
          source &&
          isWorkflowOpen(message.workflowPhase)
          ? [JSON.stringify([source, message.workflowRunId])]
          : [];
      }),
    )
    .sort()
    .join("\n");
  useEffect(() => {
    if (!ready || !activeRuns) return;
    const stops = [...new Set(activeRuns.split("\n"))].map((key) => {
      const [source, id] = JSON.parse(key) as [string, string];
      const update = () => {
        const run = workflowRuns.snapshot(source, id).run;
        if (run) receive(source, run);
      };
      const stop = workflowRuns.subscribe(source, id, update);
      update();
      return stop;
    });
    return () => stops.forEach((stop) => stop());
  }, [ready, activeRuns, receive]);
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const summaries = await workflowApi<FlowRunSummary[]>(
          endpoint,
          "/runs",
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        const pending = stateRef.current.sessions.some(
          (session) =>
            (session.workflow?.endpoint === endpoint &&
              session.workflow.pending) ||
            session.pendingWorkflow?.endpoint === endpoint,
        );
        setState((current) =>
          mergeWorkflowRuns(
            current,
            summaries,
            endpoint,
            !pending && submittingRef.current.size === 0,
          ),
        );
      } catch {
        /* Session details expose retryable errors without hiding local history. */
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 15_000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, ready, receive, setState]);

  /** Bound sessions run their own Flow; ordinary chats pass the chosen one. */
  async function start(
    sessionId: string,
    input: JsonValue,
    mode: FlowMode,
    flow?: FlowCatalogEntry,
    seed?: Session,
  ) {
    const session =
      stateRef.current.sessions.find((item) => item.id === sessionId) ??
      (seed?.id === sessionId ? seed : undefined);
    const bound = session?.workflow;
    const target =
      bound ??
      session?.pendingWorkflow ??
      (flow
        ? {
            id: flow.id,
            title: flow.title,
            endpoint,
            inputSchema: flow.inputSchema,
          }
        : undefined);
    if (
      !session ||
      !target ||
      submittingRef.current.has(sessionId) ||
      session.messages.some((message) => isWorkflowOpen(message.workflowPhase))
    )
      return;
    const pending = (bound
      ? bound.pending
      : session.pendingWorkflow?.pending) ?? {
      requestId: crypto.randomUUID(),
      input,
      mode,
    };
    const withPending = (item: Session): Session =>
      bound && item.workflow
        ? { ...item, workflow: { ...item.workflow, pending } }
        : { ...item, pendingWorkflow: { ...target, pending } };
    const clearPending = (item: Session): Session => {
      if (item.workflow) {
        const { pending: _, ...workflow } = item.workflow;
        return { ...item, workflow };
      }
      const { pendingWorkflow: _, ...rest } = item;
      return rest;
    };
    submittingRef.current.add(sessionId);
    setSubmitting([...submittingRef.current]);
    setErrors((current) => ({ ...current, [sessionId]: "" }));
    setState((current) => ({
      ...current,
      sessions: current.sessions.some((item) => item.id === sessionId)
        ? current.sessions.map((item) =>
            item.id === sessionId ? withPending(item) : item,
          )
        : [withPending(session), ...current.sessions].slice(0, 100),
    }));
    let acceptedRunId: string | undefined;
    try {
      const { runId } = await workflowApi<{ runId: string }>(
        target.endpoint,
        `/${encodeURIComponent(target.id)}/runs`,
        pending,
      );
      acceptedRunId = runId;
      setState((current) => ({
        ...current,
        sessions: current.sessions
          .map((item) => {
            if (item.id !== sessionId) return item;
            const cleared = clearPending(item);
            if (
              item.messages.some((message) => message.workflowRunId === runId)
            )
              return cleared;
            const values =
              pending.input &&
              typeof pending.input === "object" &&
              !Array.isArray(pending.input)
                ? Object.values(pending.input)
                : [];
            const text =
              values.length === 1 && typeof values[0] === "string"
                ? values[0]
                : JSON.stringify(pending.input, null, 2);
            const ref = bound
              ? {}
              : {
                  workflow: {
                    id: target.id,
                    title: target.title,
                    endpoint: target.endpoint,
                  },
                };
            const messages: Message[] = [
              { id: `${runId}:input`, role: "user", text, status: "complete" },
              {
                id: `${runId}:output`,
                role: "assistant",
                text: "正在运行",
                status: "streaming",
                workflowRunId: runId,
                workflowPhase: "queued",
                ...ref,
              },
            ];
            return {
              ...cleared,
              updatedAt: Date.now(),
              messages: [...item.messages, ...messages].slice(-200),
            };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt),
      }));
      const run = await workflowApi<FlowRun>(
        target.endpoint,
        `/runs/${encodeURIComponent(runId)}`,
      );
      receive(target.endpoint, run);
    } catch (cause) {
      if (
        cause instanceof WorkflowApiError &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((item) =>
            item.id === sessionId ? clearPending(item) : item,
          ),
        }));
      }
      setErrors((current) => ({
        ...current,
        [sessionId]: errorMessage(cause, message("submissionFailed")),
      }));
    } finally {
      submittingRef.current.delete(sessionId);
      setSubmitting([...submittingRef.current]);
    }
    return acceptedRunId;
  }
  /** Drops an unconfirmed ordinary-chat submission the user chose to abandon. */
  function discardPending(sessionId: string) {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) => {
        if (item.id !== sessionId || !item.pendingWorkflow) return item;
        const { pendingWorkflow: _, ...rest } = item;
        return rest;
      }),
    }));
  }
  async function cancel(sessionId: string) {
    const session = stateRef.current.sessions.find(
      (item) => item.id === sessionId,
    );
    const open = session?.messages
      .slice()
      .reverse()
      .find((message) => isWorkflowOpen(message.workflowPhase));
    const id = open?.workflowRunId;
    const source = session && open ? messageEndpoint(session, open) : undefined;
    if (!id || !source) return;
    try {
      receive(
        source,
        await workflowApi<FlowRun>(
          source,
          `/runs/${encodeURIComponent(id)}/cancel`,
          { requestId: crypto.randomUUID() },
        ),
      );
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [sessionId]: errorMessage(cause, message("cancelFailed")),
      }));
    }
  }
  /** True while a run in this session still blocks another submission. */
  const hasOpenRun = (sessionId?: string) =>
    Boolean(
      state.sessions
        .find((item) => item.id === sessionId)
        ?.messages.some(
          (message) =>
            message.workflowRunId && isWorkflowOpen(message.workflowPhase),
        ),
    );
  return {
    endpoint,
    runs,
    start,
    cancel,
    discardPending,
    hasOpenRun,
    receive,
    errors: Object.fromEntries(
      Object.entries(errors).map(([id, problem]) => [
        id,
        messageText(problem, i18n),
      ]),
    ),
    submitting,
  };
}
