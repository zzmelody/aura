import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Workspace, Message } from "@aura/core/types";
import type {
  FlowMode,
  FlowRun,
  FlowRunSummary,
  JsonValue,
} from "@aura/protocol/types";
import {
  applyWorkflowRun,
  isWorkflowActive,
  isWorkflowOpen,
  mergeWorkflowRuns,
  workflowApi,
  workflowRunKey,
  WorkflowApiError,
} from "./workflowSessions";

export function useWorkflowSessions(
  state: Workspace,
  setState: Dispatch<SetStateAction<Workspace>>,
  ready: boolean,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const endpoint = state.endpoint || "http://127.0.0.1:4311";
  const [runs, setRuns] = useState<Record<string, FlowRun>>({});
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submittingRef = useRef(new Set<string>());
  const receive = useCallback(
    (source: string, run: FlowRun) => {
      setRuns((current) => ({
        ...current,
        [workflowRunKey(source, run.id)]: run,
      }));
      setState((current) => applyWorkflowRun(current, source, run));
    },
    [setState],
  );
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
            session.workflow?.endpoint === endpoint && session.workflow.pending,
        );
        const activeIds = new Set(
          stateRef.current.sessions
            .filter((session) => session.workflow?.endpoint === endpoint)
            .flatMap((session) =>
              session.messages
                .filter(
                  (message) =>
                    message.workflowRunId &&
                    (isWorkflowOpen(message.workflowPhase) ||
                      message.status === "streaming"),
                )
                .map((message) => message.workflowRunId),
            ),
        );
        setState((current) =>
          mergeWorkflowRuns(
            current,
            summaries,
            endpoint,
            !pending && submittingRef.current.size === 0,
          ),
        );
        await Promise.allSettled(
          summaries
            .filter((run) => activeIds.has(run.id))
            .map(async (summary) => {
              const run = await workflowApi<FlowRun>(
                endpoint,
                `/runs/${encodeURIComponent(summary.id)}`,
                undefined,
                abort.signal,
              );
              if (!abort.signal.aborted) receive(endpoint, run);
            }),
        );
      } catch {
        /* Session details expose retryable errors without hiding local history. */
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, ready, receive, setState]);

  async function start(sessionId: string, input: JsonValue, mode: FlowMode) {
    const session = stateRef.current.sessions.find(
      (item) => item.id === sessionId,
    );
    const binding = session?.workflow;
    if (
      !binding ||
      submittingRef.current.has(sessionId) ||
      session.messages.some((message) => isWorkflowOpen(message.workflowPhase))
    )
      return;
    const pending = binding.pending ?? {
      requestId: crypto.randomUUID(),
      input,
      mode,
    };
    submittingRef.current.add(sessionId);
    setSubmitting([...submittingRef.current]);
    setErrors((current) => ({ ...current, [sessionId]: "" }));
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === sessionId && item.workflow
          ? { ...item, workflow: { ...item.workflow, pending } }
          : item,
      ),
    }));
    let acceptedRunId: string | undefined;
    try {
      const { runId } = await workflowApi<{ runId: string }>(
        binding.endpoint,
        `/${encodeURIComponent(binding.id)}/runs`,
        pending,
      );
      acceptedRunId = runId;
      setState((current) => ({
        ...current,
        sessions: current.sessions
          .map((item) => {
            if (item.id !== sessionId || !item.workflow) return item;
            const { pending: _, ...workflow } = item.workflow;
            if (
              item.messages.some((message) => message.workflowRunId === runId)
            )
              return { ...item, workflow };
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
            const messages: Message[] = [
              { id: `${runId}:input`, role: "user", text, status: "complete" },
              {
                id: `${runId}:output`,
                role: "assistant",
                text: "正在运行",
                status: "streaming",
                workflowRunId: runId,
                workflowPhase: "queued",
              },
            ];
            return {
              ...item,
              workflow,
              updatedAt: Date.now(),
              messages: [...item.messages, ...messages].slice(-200),
            };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt),
      }));
      const run = await workflowApi<FlowRun>(
        binding.endpoint,
        `/runs/${encodeURIComponent(runId)}`,
      );
      receive(binding.endpoint, run);
    } catch (cause) {
      if (
        cause instanceof WorkflowApiError &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((item) => {
            if (item.id !== sessionId || !item.workflow) return item;
            const { pending: _, ...workflow } = item.workflow;
            return { ...item, workflow };
          }),
        }));
      }
      setErrors((current) => ({
        ...current,
        [sessionId]:
          cause instanceof Error ? cause.message : "提交失败，请重试。",
      }));
    } finally {
      submittingRef.current.delete(sessionId);
      setSubmitting([...submittingRef.current]);
    }
    return acceptedRunId;
  }
  async function cancel(sessionId: string) {
    const session = stateRef.current.sessions.find(
      (item) => item.id === sessionId,
    );
    const id = session?.messages
      .slice()
      .reverse()
      .find((message) => isWorkflowOpen(message.workflowPhase))?.workflowRunId;
    if (!id || !session?.workflow) return;
    try {
      receive(
        session.workflow.endpoint,
        await workflowApi<FlowRun>(
          session.workflow.endpoint,
          `/runs/${encodeURIComponent(id)}/cancel`,
          { requestId: crypto.randomUUID() },
        ),
      );
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [sessionId]: cause instanceof Error ? cause.message : "取消失败。",
      }));
    }
  }
  return { runs, start, cancel, receive, errors, submitting };
}
