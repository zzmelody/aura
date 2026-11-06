import { useCallback, useRef, useState } from "react";
import { extractFlowSvg, readFlowSvg, type FlowDiagram } from "./flow-analysis";
import { extractFlowCode } from "./flowDraft";

const STORAGE_KEY = "aura.flow-analysis.v1";
type Entry = { code: string; diagram: FlowDiagram };
type Target = { key: string; code: string; id: string };

function load(): Entry[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("entries" in value) ||
      !Array.isArray(value.entries)
    )
      return [];
    return value.entries.slice(-8).flatMap((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("code" in entry) ||
        typeof entry.code !== "string" ||
        !("svg" in entry) ||
        typeof entry.svg !== "string"
      )
        return [];
      const diagram = readFlowSvg(entry.svg, `stored-${crypto.randomUUID()}`);
      return diagram ? [{ code: entry.code, diagram }] : [];
    });
  } catch {
    return [];
  }
}

export function useFlowAnalysis() {
  const [entries, setEntries] = useState(load);
  const saved = useRef(entries);
  const [target, setTarget] = useState<Target>();
  const current = useRef(target);
  const [error, setError] = useState("");
  const selectSource = useCallback((key: string, code: string) => {
    if (current.current?.key === key && current.current.code === code) return;
    const next = code ? { key, code, id: crypto.randomUUID() } : undefined;
    current.current = next;
    setTarget(next);
    setError("");
  }, []);
  const accept = useCallback((reply: string): { code?: string } | undefined => {
    const source = current.current;
    if (!source) return;
    const svg = extractFlowSvg(reply, source.id);
    if (!svg) return;
    const diagram = readFlowSvg(svg, `flow-${crypto.randomUUID()}`);
    if (!diagram) {
      setError(
        "Agent 返回的 SVG 无法显示，请在右侧要求重新生成完整的 SVG 流程图。",
      );
      return;
    }
    const code = extractFlowCode(reply);
    if (code !== undefined && source.code.length > 7000) {
      setError(
        "当前源码超过分析上下文范围，已保留原草稿；请先拆分流程，再让 Agent 修改。",
      );
      return;
    }
    const entry = { code: code ?? source.code, diagram };
    const next = [
      ...saved.current.filter((item) => item.code !== entry.code),
      entry,
    ].slice(-8);
    saved.current = next;
    setEntries(next);
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          entries: next.map((item) => ({
            code: item.code,
            svg: item.diagram.svg,
          })),
        }),
      );
      setError("");
    } catch {
      setError("流程图已生成，本机保存失败；刷新前请导出草稿。");
    }
    return { code };
  }, []);
  return { target, selectSource, accept, entries, error };
}
export type FlowAnalysisController = ReturnType<typeof useFlowAnalysis>;
