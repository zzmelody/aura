import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import type { CodexAuthStatus, CodexLoginRequest } from "@aura/protocol/types";
import type { WorkspaceController } from "./useWorkspace";

const localRuntime = "http://127.0.0.1:4311";

function browserMethod(): CodexLoginRequest["method"] {
  if (Platform.OS !== "web") return "device_code";
  const host = globalThis.location?.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    ? "browser"
    : "device_code";
}

export function useCodexAuth(workspace: WorkspaceController) {
  const endpoint = workspace.state.endpoint || localRuntime;
  const [status, setStatus] = useState<CodexAuthStatus>({
    state: "signed_out",
    model: "gpt-5.6-terra",
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`${endpoint}/auth/codex/status`, { signal });
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
          model: "gpt-5.6-terra",
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

  const start = useCallback(async () => {
    const method = browserMethod();
    const authWindow =
      Platform.OS === "web" && method === "browser"
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
        const failure = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        throw new Error(
          typeof failure?.message === "string"
            ? failure.message
            : `DSH 登录服务返回了 ${response.status}。`,
        );
      }
      const next = (await response.json()) as CodexAuthStatus;
      setStatus(next);
      const url = next.state === "pending" ? next.authUrl ?? next.verificationUri : undefined;
      if (url && authWindow) authWindow.location.href = url;
      else if (url) await Linking.openURL(url);
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
  }, [endpoint, status.model]);

  return { status, loading, start, refresh, endpoint };
}

export type CodexAuthController = ReturnType<typeof useCodexAuth>;
