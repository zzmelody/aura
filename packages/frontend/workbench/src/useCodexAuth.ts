import { useCallback, useEffect, useState } from "react";
import type {
  CodexAuthStatus,
  CodexLoginInputRequest,
  CodexLoginRequest,
} from "@aura/protocol/types";
import type { WorkspaceController } from "./useWorkspace";
import { openExternal, platform } from "./platform";

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
  return typeof failure?.message === "string" ? failure.message : fallback;
}

export function useCodexAuth(workspace: WorkspaceController) {
  const endpoint = workspace.state.endpoint || localRuntime;
  const [status, setStatus] = useState<CodexAuthStatus>({
    state: "signed_out",
    model: "gpt-6.1-sol",
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`${endpoint}/auth/codex/status`, {
          signal,
        });
        if (!response.ok) throw new Error("status unavailable");
        const next = (await response.json()) as CodexAuthStatus;
        setStatus(next);
        if (next.state === "authenticated")
          workspace.setState((current) => ({
            ...current,
            endpoint,
            provider: "codex",
          }));
        return next;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus({
          state: "error",
          message: "请先启动 Aura 工作台服务，再登录 Codex。",
          model: "gpt-6.1-sol",
        });
      } finally {
        setLoading(false);
      }
    },
    [endpoint, workspace.setState],
  );

  useEffect(() => {
    if (!workspace.ready) return;
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
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
          throw new Error(
            await responseError(
              response,
              `DSH 登录服务返回了 ${response.status}。`,
            ),
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
              ? `无法连接 ${endpoint}。请通过 Aura 的 dev、preview 或 desktop 命令启动应用。`
              : error instanceof Error
                ? error.message
                : "无法开始 Codex 登录。",
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
        throw new Error(await responseError(response, "无法取消 Codex 登录。"));
      const next = (await response.json()) as CodexAuthStatus;
      setStatus(next);
      return next;
    } catch (error) {
      setStatus({
        state: "error",
        message:
          error instanceof Error ? error.message : "无法取消 Codex 登录。",
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
          throw new Error(
            await responseError(response, "无法提交 Codex 授权结果。"),
          );
        setStatus((await response.json()) as CodexAuthStatus);
      } catch (error) {
        setStatus({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "无法提交 Codex 授权结果。",
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

  return { status, loading, start, cancel, submit, restart, refresh, endpoint };
}

export type CodexAuthController = ReturnType<typeof useCodexAuth>;
