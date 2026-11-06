import { useCallback, useEffect, useState } from "react";
import type {
  CodexAuthStatus,
  CodexLoginInputRequest,
  CodexLoginRequest,
} from "@aura/protocol/types";
import type { WorkspaceController } from "./useWorkspace";
import { openExternal, platform } from "./platform";
import { startupFetch } from "./startup-fetch";
import { isAuthMessageKey, useAuthMessages } from "./auth-messages.ts";
import { apiErrorText } from "./api-error-messages.ts";
import {
  errorMessage,
  messageText,
  MessageError,
  type MessageReference,
} from "@aura/i18n/runtime";

type AuthViewStatus =
  | Exclude<CodexAuthStatus, { state: "error" }>
  | (Omit<Extract<CodexAuthStatus, { state: "error" }>, "message"> & {
      message: string | MessageReference;
    });

const localRuntime = "http://127.0.0.1:4311";

function browserMethod(): CodexLoginRequest["method"] {
  if (platform() === "mobile") return "device_code";
  const host = globalThis.location?.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    ? "browser"
    : "device_code";
}

async function responseError(response: Response, fallback: string) {
  const failure = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  return apiErrorText(failure, fallback);
}

export function useCodexAuth(workspace: WorkspaceController) {
  const { t, i18n } = useAuthMessages();
  const { setState } = workspace;
  const endpoint = workspace.state.endpoint || localRuntime;
  const [status, setStatus] = useState<AuthViewStatus>({
    state: "signed_out",
    model: "gpt-6.1-sol",
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await startupFetch(
          `${endpoint}/auth/codex/status`,
          signal,
        );
        if (!response.ok) throw new Error("status unavailable");
        const next = (await response.json()) as CodexAuthStatus;
        setStatus(next);
        // Signing in upgrades a demo provider; an explicit gateway choice stays.
        if (next.state === "authenticated")
          setState((current) =>
            current.provider === "lumina" || current.provider === "custom"
              ? current
              : { ...current, endpoint, provider: "codex" },
          );
        return next;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus({
          state: "error",
          message: "serviceUnavailable",
          model: "gpt-6.1-sol",
        });
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [endpoint, setState],
  );

  useEffect(() => {
    if (!workspace.ready) return;
    setLoading(true);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const result = await refresh(abort.signal);
      if (!result && !abort.signal.aborted) timer = setTimeout(read, 3000);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [refresh, workspace.ready]);

  useEffect(() => {
    if (status.state !== "pending") return;
    const timer = setInterval(() => void refresh(), 1800);
    return () => clearInterval(timer);
  }, [refresh, status.state]);

  useEffect(() => {
    if (status.state !== "pending") return;
    const check = () => void refresh();
    const onVisibility = () => {
      if (globalThis.document.visibilityState === "visible") check();
    };
    globalThis.window.addEventListener("focus", check);
    globalThis.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      globalThis.window.removeEventListener("focus", check);
      globalThis.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, status.state]);

  const start = useCallback(
    async (requestedMethod?: CodexLoginRequest["method"]) => {
      const method = requestedMethod ?? browserMethod();
      const authWindow =
        platform() !== "mobile" && method === "browser"
          ? globalThis.open?.("", "_blank")
          : null;
      setLoading(true);
      try {
        const response = await fetch(`${endpoint}/auth/codex/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method } satisfies CodexLoginRequest),
        });
        if (!response.ok) {
          throw new MessageError(
            await responseError(response, "loginStartFailed"),
          );
        }
        const next = (await response.json()) as CodexAuthStatus;
        setStatus(next);
        const url =
          next.state === "pending"
            ? (next.authUrl ?? next.verificationUri)
            : undefined;
        if (url && authWindow) authWindow.location.href = url;
        else if (url) await openExternal(url);
        else authWindow?.close();
      } catch (error) {
        authWindow?.close();
        setStatus({
          state: "error",
          message:
            error instanceof TypeError
              ? "serviceUnavailable"
              : errorMessage(error, "loginStartFailed"),
          model: status.model,
        });
      } finally {
        setLoading(false);
      }
    },
    [endpoint, status.model],
  );

  const cancel = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${endpoint}/auth/codex/cancel`, {
        method: "POST",
      });
      if (!response.ok)
        throw new MessageError(
          await responseError(response, "loginCancelFailed"),
        );
      const next = (await response.json()) as CodexAuthStatus;
      setStatus(next);
      return next;
    } catch (error) {
      setStatus({
        state: "error",
        message: errorMessage(error, "loginCancelFailed"),
        model: status.model,
      });
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [endpoint, status.model]);

  const submit = useCallback(
    async (input: string) => {
      setLoading(true);
      try {
        const response = await fetch(`${endpoint}/auth/codex/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input } satisfies CodexLoginInputRequest),
        });
        if (!response.ok)
          throw new MessageError(
            await responseError(response, "loginSubmitFailed"),
          );
        setStatus((await response.json()) as CodexAuthStatus);
      } catch (error) {
        setStatus({
          state: "error",
          message: errorMessage(error, "loginSubmitFailed"),
          model: status.model,
        });
      } finally {
        setLoading(false);
      }
    },
    [endpoint, status.model],
  );

  const restart = useCallback(
    async (method: CodexLoginRequest["method"]) => {
      const cancelled = await cancel();
      if (cancelled) await start(method);
    },
    [cancel, start],
  );

  // Translate the UI projection only. A language change never restarts login,
  // polling, or a pending authorization operation.
  const displayedStatus: CodexAuthStatus =
    status.state === "error"
      ? {
          ...status,
          message:
            typeof status.message === "string" &&
            isAuthMessageKey(status.message)
              ? t(status.message)
              : messageText(
                  apiErrorText(status.messageDetails, status.message),
                  i18n,
                ),
        }
      : status.state === "pending" && status.messageDetails
        ? {
            ...status,
            message: messageText(
              apiErrorText(status.messageDetails, status.message ?? ""),
              i18n,
            ),
          }
        : status;
  return {
    status: displayedStatus,
    loading,
    start,
    cancel,
    submit,
    restart,
    refresh,
    endpoint,
  };
}

export type CodexAuthController = ReturnType<typeof useCodexAuth>;
