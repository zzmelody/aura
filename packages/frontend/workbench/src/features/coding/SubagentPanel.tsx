import React, { useEffect, useState } from "react";
import type { CodingSubagent } from "@aura/protocol/types";
import { readCodingSubagents, stopCodingSubagent } from "./api.ts";

export function SubagentPanel({
  endpoint,
  sessionId,
  running,
}: {
  endpoint: string;
  sessionId: string;
  running: boolean;
}) {
  const [agents, setAgents] = useState<CodingSubagent[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await readCodingSubagents(endpoint, sessionId);
        if (!disposed) {
          setAgents(result);
          setError("");
        }
      } catch {
        if (!disposed && running) setError("暂时无法读取子 Agent 状态。");
      }
      if (!disposed && running) timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [endpoint, sessionId, running]);
  const labels = {
    running: "工作中",
    complete: "已完成",
    stopped: "已停止",
    error: "未完成",
  };
  return (
    <>
      {agents.map((agent) => (
        <details className="coding-subagent" key={agent.id}>
          <summary>
            {agent.role} · {agent.label} · {labels[agent.status]}
          </summary>
          {agent.result ? (
            <p style={{ whiteSpace: "pre-wrap" }}>{agent.result}</p>
          ) : (
            <p>等待子 Agent 返回结果。</p>
          )}
          {agent.status === "running" ? (
            <button
              type="button"
              onClick={() => {
                void stopCodingSubagent(endpoint, sessionId, agent.id).catch(
                  () => setError("停止子 Agent 失败，请重试。"),
                );
              }}
            >
              停止此 Agent
            </button>
          ) : null}
        </details>
      ))}
      {error ? <p role="status">{error}</p> : null}
    </>
  );
}
