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
      if (!response.ok) throw new Error("login unavailable");
      const next = (await response.json()) as CodexAuthStatus;
      setStatus(next);
      const url = next.state === "pending" ? next.authUrl ?? next.verificationUri : undefined;
      if (url && authWindow) authWindow.location.href = url;
      else if (url) await Linking.openURL(url);
      else authWindow?.close();
    } catch {
      authWindow?.close();
      setStatus({
        state: "error",
        message: "无法开始登录。请确认 Aura 工作台服务正在运行。",
        model: status.model,
      });
    } finally {
      setLoading(false);
    }
  }, [endpoint, status.model]);

  return { status, loading, start, refresh, endpoint };
}

export type CodexAuthController = ReturnType<typeof useCodexAuth>;
