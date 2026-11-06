import { useCallback, useRef, useState } from "react";
import { extractFlowSvg, readFlowSvg, type FlowDiagram } from "./flow-analysis";
import { extractFlowCode } from "./flowDraft";
import {
  useWorkflowMessages,
  type WorkflowMessageKey,
} from "./workflow-messages.ts";

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
  const { t } = useWorkflowMessages();
  const [entries, setEntries] = useState(load);
  const saved = useRef(entries);
  const [target, setTarget] = useState<Target>();
  const current = useRef(target);
  const [error, setError] = useState<WorkflowMessageKey>();
  const selectSource = useCallback((key: string, code: string) => {
    if (current.current?.key === key && current.current.code === code) return;
    const next = code ? { key, code, id: crypto.randomUUID() } : undefined;
    current.current = next;
    setTarget(next);
    setError(undefined);
  }, []);
  const accept = useCallback((reply: string): { code?: string } | undefined => {
    const source = current.current;
    if (!source) return;
    const svg = extractFlowSvg(reply, source.id);
    if (!svg) return;
    const diagram = readFlowSvg(svg, `flow-${crypto.randomUUID()}`);
    if (!diagram) {
      setError("analysisSvgInvalid");
      return;
    }
    const code = extractFlowCode(reply);
    if (code !== undefined && source.code.length > 7000) {
      setError("analysisSourceTooLong");
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
      setError(undefined);
    } catch {
      setError("analysisSaveFailed");
    }
    return { code };
  }, []);
  return {
    target,
    selectSource,
    accept,
    entries,
    error: error ? t(error) : "",
  };
}
export type FlowAnalysisController = ReturnType<typeof useFlowAnalysis>;
