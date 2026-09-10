import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "@aura/ui/web";
import {
  ChevronRight,
  Clock3,
  GitBranch,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { Label, useTheme } from "@aura/ui/components";
import { fonts, type as textType } from "@aura/ui/theme";
import type {
  FlowCatalog,
  FlowHistory,
  FlowMode,
  FlowPhase,
  FlowRun,
  FlowRunSummary,
  JsonValue,
} from "@aura/protocol/types";

const phaseLabels: Record<FlowPhase, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const active = (phase?: FlowPhase) => phase === "queued" || phase === "running";
const requestId = () => crypto.randomUUID();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "流程服务暂时不可用。";

async function api<T>(
  endpoint: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/flows${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const result = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(
      result?.message ||
        `流程服务连接失败（${response.status}）。请检查设置中的后端地址。`,
    );
  return result as T;
}

function outputText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function reportText(value: JsonValue | undefined): string | undefined {
  const output = asObject(value);
  return typeof output?.report === "string" ? output.report : undefined;
}

type JsonObject = { [key: string]: JsonValue };

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

function schemaInitialValue(schemaValue: JsonValue | undefined): JsonValue {
  const schema = asObject(schemaValue);
  if (!schema) return null;
  if (schema.default !== undefined) return schema.default;
  const kind = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (kind === "object") {
    const properties = asObject(schema.properties);
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    );
    return Object.fromEntries(
      Object.entries(properties ?? {})
        .filter(
          ([name, property]) =>
            required.has(name) || asObject(property)?.default !== undefined,
        )
        .map(([name, property]) => [name, schemaInitialValue(property)]),
    );
  }
  if (kind === "array") return [];
  if (kind === "boolean") return false;
  if (kind === "integer" || kind === "number") return 0;
  if (kind === "string") {
    const options = Array.isArray(schema.enum) ? schema.enum : [];
    return options[0] ?? "";
  }
  return null;
}

function SchemaField({
  name,
  required,
  schemaValue,
  value,
  onChange,
}: {
  name: string;
  required: boolean;
  schemaValue: JsonValue;
  value: JsonValue | undefined;
  onChange(value: JsonValue): void;
}) {
  const { colors } = useTheme();
  const schema = asObject(schemaValue) ?? {};
  const kind = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const options = Array.isArray(schema.enum) ? schema.enum : undefined;
  const label = typeof schema.title === "string" ? schema.title : name;
  const description =
    typeof schema.description === "string" ? schema.description : "";
  const example = Array.isArray(schema.examples)
    ? schema.examples[0]
    : undefined;

  return (
    <View style={styles.schemaField}>
      <View style={styles.fieldHeading}>
        <Text style={[textType.small, { color: colors.text }]}>{label}</Text>
        <Label color={required ? colors.accent : colors.muted}>
          {required ? "REQUIRED" : "OPTIONAL"}
        </Label>
      </View>
      {description ? (
        <Text style={[textType.small, { color: colors.muted }]}>
          {description}
        </Text>
      ) : null}
      {options ? (
        <View style={styles.optionRow}>
          {options.map((option) => {
            const selected = JSON.stringify(value) === JSON.stringify(option);
            return (
              <Pressable
                key={JSON.stringify(option)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => onChange(option)}
                style={[
                  styles.option,
                  {
                    backgroundColor: selected ? colors.soft : colors.input,
                    borderColor: selected ? colors.accent : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    textType.small,
                    { color: selected ? colors.accent : colors.secondary },
                  ]}
                >
                  {typeof option === "string" ? option : JSON.stringify(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : kind === "boolean" ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: value === true }}
          onPress={() => onChange(value !== true)}
          style={[
            styles.toggle,
            {
              backgroundColor: value === true ? colors.soft : colors.input,
              borderColor: value === true ? colors.accent : colors.border,
            },
          ]}
        >
          <View
            style={[
              styles.toggleDot,
              {
                backgroundColor: value === true ? colors.accent : colors.muted,
              },
            ]}
          />
          <Text style={[textType.small, { color: colors.secondary }]}>
            {value === true ? "已启用" : "未启用"}
          </Text>
        </Pressable>
      ) : kind === "string" || kind === "number" || kind === "integer" ? (
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={kind === "string" ? undefined : "numeric"}
          multiline={kind === "string" && Number(schema.maxLength ?? 0) > 240}
          onChangeText={(next) => {
            if (kind === "string") return onChange(next);
            const numeric = Number(next);
            onChange(next.trim() && Number.isFinite(numeric) ? numeric : next);
          }}
          placeholder={typeof example === "string" ? example : name}
          placeholderTextColor={colors.muted}
          style={[
            styles.schemaInput,
            kind === "string" && Number(schema.maxLength ?? 0) > 240
              ? styles.schemaTextarea
              : undefined,
            {
              backgroundColor: colors.input,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          value={value === undefined || value === null ? "" : String(value)}
        />
      ) : (
        <TextInput
          accessibilityLabel={`${label} JSON`}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={(next) => {
            try {
              onChange(JSON.parse(next) as JsonValue);
            } catch {
              // Keep the last valid value; the full JSON editor below remains available.
            }
          }}
          placeholder="JSON"
          placeholderTextColor={colors.muted}
          style={[
            styles.schemaInput,
            styles.schemaTextarea,
            {
              backgroundColor: colors.input,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          value={JSON.stringify(
            value ?? schemaInitialValue(schemaValue),
            null,
            2,
          )}
        />
      )}
    </View>
  );
}

function SchemaInputEditor({
  schemaValue,
  value,
  onChange,
}: {
  schemaValue: JsonValue | undefined;
  value: JsonValue;
  onChange(value: JsonValue): void;
}) {
  const schema = asObject(schemaValue);
  const properties = asObject(schema?.properties);
  const current = asObject(value);
  if (schema?.type !== "object" || !properties || !current) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  return (
    <View style={styles.schemaFields}>
      {Object.entries(properties).map(([name, property]) => (
        <SchemaField
          key={name}
          name={name}
          required={required.has(name)}
          schemaValue={property}
          value={current[name]}
          onChange={(next) => onChange({ ...current, [name]: next })}
        />
      ))}
    </View>
  );
}

/** UI-only Flow client; discovery, validation and execution stay in DSH. */
export function FlowsScreen({ endpoint }: { endpoint: string }) {
  const { colors } = useTheme();
  const [catalog, setCatalog] = useState<FlowCatalog>();
  const [flowId, setFlowId] = useState("");
  const [input, setInput] = useState('{\n  "task": ""\n}');
  const [inputView, setInputView] = useState<"form" | "json">("form");
  const [mode, setMode] = useState<FlowMode>("demo");
  const [runs, setRuns] = useState<FlowRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [run, setRun] = useState<FlowRun>();
  const [runRevision, setRunRevision] = useState(0);
  const [history, setHistory] = useState<FlowHistory>();
  const [historyStep, setHistoryStep] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedFlow = catalog?.flows.find((item) => item.id === flowId);
  const endpointRef = useRef(endpoint);
  const inputFlowRef = useRef("");
  const inputDrafts = useRef(new Map<string, string>());
  const historyRequest = useRef(0);
  endpointRef.current = endpoint;

  async function refresh(signal?: AbortSignal) {
    const [nextCatalog, nextRuns] = await Promise.all([
      api<FlowCatalog>(endpoint, "/catalog", undefined, signal),
      api<FlowRunSummary[]>(endpoint, "/runs", undefined, signal),
    ]);
    if (signal?.aborted || endpoint !== endpointRef.current) return;
    setCatalog(nextCatalog);
    setRuns(nextRuns);
    setFlowId((current) =>
      nextCatalog.flows.some((item) => item.id === current)
        ? current
        : (nextCatalog.flows.find((item) => item.available)?.id ?? ""),
    );
  }

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCatalog(undefined);
    setSelectedId("");
    setRun(undefined);
    setRuns([]);
    setHistoryStep("");
    setHistory(undefined);
    historyRequest.current++;
    setError("");
    const pollCatalog = async () => {
      try {
        const next = await api<FlowCatalog>(
          endpoint,
          "/catalog",
          undefined,
          abort.signal,
        );
        setCatalog(next);
        setFlowId((current) =>
          next.flows.some((item) => item.id === current)
            ? current
            : (next.flows.find((item) => item.available)?.id ?? ""),
        );
      } catch (cause) {
        if (!abort.signal.aborted) setError(errorText(cause));
      }
      if (!abort.signal.aborted) timer = setTimeout(pollCatalog, 1_500);
    };
    void refresh(abort.signal)
      .then(() => {
        if (!abort.signal.aborted) timer = setTimeout(pollCatalog, 1_500);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(errorText(cause));
      });
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [endpoint]);

  useEffect(() => {
    if (!selectedFlow || inputFlowRef.current === selectedFlow.id) return;
    inputFlowRef.current = selectedFlow.id;
    setInput(
      inputDrafts.current.get(selectedFlow.id) ??
        JSON.stringify(schemaInitialValue(selectedFlow.inputSchema), null, 2),
    );
  }, [selectedFlow?.id]);

  useEffect(() => {
    if (flowId && inputFlowRef.current === flowId)
      inputDrafts.current.set(flowId, input);
  }, [input]);

  useEffect(() => {
    if (!selectedId) {
      setRun(undefined);
      return;
    }
    setRun(undefined);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await api<FlowRun>(
          endpointRef.current,
          `/runs/${encodeURIComponent(selectedId)}`,
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setRun(next);
        setRuns((current) => [
          {
            id: next.id,
            flowId: next.flow.id,
            title: next.flow.title,
            inputPreview: JSON.stringify(next.input),
            status: next.status,
            mode: next.mode,
            createdAt: next.createdAt,
          },
          ...current.filter((item) => item.id !== next.id),
        ]);
        if (active(next.status)) timer = setTimeout(read, 1200);
      } catch (cause) {
        if (!abort.signal.aborted) setError(errorText(cause));
      }
    };
    void read();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selectedId, runRevision, endpoint]);

  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(input) as JsonValue, error: "" };
    } catch {
      return { value: null, error: "请输入有效的 JSON。" };
    }
  }, [input]);

  async function start() {
    if (!selectedFlow?.available || parsed.error || busy) return;
    setBusy(true);
    historyRequest.current++;
    setError("");
    setHistory(undefined);
    setHistoryStep("");
    try {
      const next = await api<{ runId: string }>(
        endpoint,
        `/${encodeURIComponent(flowId)}/runs`,
        { requestId: requestId(), input: parsed.value, mode },
      );
      setSelectedId(next.runId);
      setRun(undefined);
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run || !active(run.status) || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<FlowRun>(
        endpoint,
        `/runs/${encodeURIComponent(run.id)}/cancel`,
        {},
      );
      setRun(next);
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(stepId: string) {
    if (!run) return;
    const revision = ++historyRequest.current;
    setHistoryStep(stepId);
    setHistory(undefined);
    setError("");
    setHistoryBusy(true);
    try {
      const next = await api<FlowHistory>(
        endpoint,
        `/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(stepId)}/history`,
      );
      if (revision === historyRequest.current) setHistory(next);
    } catch (cause) {
      if (revision === historyRequest.current) setError(errorText(cause));
    } finally {
      if (revision === historyRequest.current) setHistoryBusy(false);
    }
  }

  async function loadOlderHistory() {
    if (!run || !historyStep || !history?.hasMore || historyBusy) return;
    const beforeSeq =
      history.beforeSeq ??
      (history.entries.length
        ? Math.min(...history.entries.map(({ seq }) => seq))
        : undefined);
    if (beforeSeq === undefined) return;
    const revision = historyRequest.current;
    setHistoryBusy(true);
    setError("");
    try {
      const older = await api<FlowHistory>(
        endpoint,
        `/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(historyStep)}/history?beforeSeq=${beforeSeq}`,
      );
      if (revision !== historyRequest.current) return;
      setHistory({
        ...older,
        entries: [
          ...older.entries,
          ...history.entries.filter(
            (entry) => !older.entries.some(({ seq }) => seq === entry.seq),
          ),
        ],
      });
    } catch (cause) {
      if (revision === historyRequest.current) setError(errorText(cause));
    } finally {
      if (revision === historyRequest.current) setHistoryBusy(false);
    }
  }

  function selectRun(id: string) {
    historyRequest.current++;
    setSelectedId(id);
    setRun(undefined);
    setHistory(undefined);
    setHistoryStep("");
    setHistoryBusy(false);
  }

  return (
    <div className="flow-runtime">
      <div className="runtime-heading">
        <div>
          <h2>运行已注册的 Flow</h2>
          <p>配置输入，查看运行结果和每个 Agent 的会话。</p>
        </div>
        <button
          className="icon-control"
          aria-label="刷新 Flow 目录"
          onClick={() => {
            setError("");
            void refresh().catch((cause) => setError(errorText(cause)));
          }}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {error ? (
        <div className="workspace-notice" role="alert">
          {error}
        </div>
      ) : null}
      <div className="runtime-columns">
        <section className="runtime-config" aria-label="Flow 运行配置">
          <div className="panel-heading">
            <GitBranch size={14} />
            <strong>选择 Flow</strong>
            <span className="count">{catalog?.flows.length ?? 0}</span>
          </div>
          {!catalog ? (
            <div className="runtime-empty">
              {error ? (
                <span>无法连接 Flow 服务，启动服务后点击刷新。</span>
              ) : (
                <>
                  <ActivityIndicator color={colors.accent} />
                  正在读取 Flow 目录…
                </>
              )}
            </div>
          ) : !catalog.flows.length ? (
            <div className="runtime-empty">
              暂无已注册的 Flow，可先在代码草稿中编写。
            </div>
          ) : (
            <>
              <div className="compact-catalog">
                {catalog.flows.map((flow) => (
                  <button
                    key={flow.id}
                    className={`catalog-item${flowId === flow.id ? " selected" : ""}`}
                    aria-pressed={flowId === flow.id}
                    disabled={!flow.available}
                    onClick={() => setFlowId(flow.id)}
                  >
                    <span>
                      <GitBranch size={14} />
                      <strong>{flow.title}</strong>
                    </span>
                    <small>{flow.error || flow.description}</small>
                  </button>
                ))}
              </div>
              <div className="panel-heading input-heading">
                <strong>运行参数</strong>
                <div className="segmented" aria-label="参数编辑方式">
                  <button
                    aria-pressed={inputView === "form"}
                    onClick={() => setInputView("form")}
                  >
                    表单
                  </button>
                  <button
                    aria-pressed={inputView === "json"}
                    onClick={() => setInputView("json")}
                  >
                    JSON
                  </button>
                </div>
              </div>
              <div className="runtime-input">
                {inputView === "form" &&
                selectedFlow?.inputSchema &&
                !parsed.error &&
                asObject(parsed.value) ? (
                  <SchemaInputEditor
                    schemaValue={selectedFlow.inputSchema}
                    value={parsed.value}
                    onChange={(next) => setInput(JSON.stringify(next, null, 2))}
                  />
                ) : (
                  <TextInput
                    accessibilityLabel="Flow JSON 输入"
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    onChangeText={setInput}
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.input,
                        color: colors.text,
                        borderColor: parsed.error
                          ? colors.danger
                          : colors.border,
                      },
                    ]}
                    value={input}
                  />
                )}
                {parsed.error ? (
                  <p className="error" role="alert">
                    {parsed.error}
                  </p>
                ) : null}
              </div>
              <div className="runtime-launch">
                <label>
                  运行模式
                  <select
                    aria-label="Flow 运行模式"
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as FlowMode)
                    }
                  >
                    <option value="demo">DSH 演示</option>
                    <option value="codex">Codex 订阅</option>
                  </select>
                </label>
                <button
                  className="primary-button"
                  disabled={
                    !selectedFlow?.available || Boolean(parsed.error) || busy
                  }
                  onClick={() => void start()}
                >
                  <Play size={14} />
                  {busy ? "正在提交…" : "开始运行"}
                </button>
              </div>
            </>
          )}
        </section>
        <section className="runtime-results" aria-label="Flow 运行结果">
          <div className="panel-heading">
            <Clock3 size={14} />
            <strong>运行记录</strong>
            <span className="count">{runs.length}</span>
          </div>
          <div className="run-picker">
            <select
              aria-label="选择运行记录"
              value={selectedId}
              onChange={(event) => selectRun(event.target.value)}
            >
              <option value="">
                {runs.length ? "选择一条运行记录" : "暂无运行记录"}
              </option>
              {runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {phaseLabels[item.status]} · {item.title} ·{" "}
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </option>
              ))}
            </select>
          </div>
          {!selectedId ? (
            <div className="runtime-empty result-empty">
              <Play size={25} strokeWidth={1.3} />
              <h3>让 Flow 开始工作</h3>
              <p>运行后在这里查看步骤、输出和 Agent 会话。</p>
            </div>
          ) : !run ? (
            <div className="runtime-empty">
              <ActivityIndicator color={colors.accent} />
              正在读取运行记录…
            </div>
          ) : (
            <div className="run-detail">
              <div className="run-detail-heading">
                <div>
                  <h3>{run.flow.title}</h3>
                  <span className={`phase phase-${run.status}`}>
                    {phaseLabels[run.status]}
                  </span>
                  <small>
                    {new Date(run.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
                <button
                  className="icon-control"
                  aria-label="刷新运行状态"
                  onClick={() => setRunRevision((value) => value + 1)}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              {active(run.status) ? (
                <button
                  className="tool-button"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  <Square size={12} />
                  停止运行
                </button>
              ) : null}
              <div className="agent-steps">
                {run.steps.map((step, index) => (
                  <button
                    key={step.id}
                    className={`agent-step${historyStep === step.id ? " selected" : ""}`}
                    aria-label={`查看 ${step.label} 会话`}
                    aria-pressed={historyStep === step.id}
                    onClick={() => void openHistory(step.id)}
                  >
                    <span className={`step-number phase-${step.status}`}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>
                      <strong>{step.label}</strong>
                      <small>
                        {phaseLabels[step.status]} · {step.preset}
                      </small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              {run.error ? (
                <p className="error" role="alert">
                  {run.error}
                </p>
              ) : null}
              {run.output !== undefined ? (
                <div className="run-output" hidden={Boolean(historyStep)}>
                  <div className="panel-heading">
                    <strong>输出结果</strong>
                  </div>
                  {reportText(run.output) ? (
                    <div className="report-text">{reportText(run.output)}</div>
                  ) : null}
                  <details open={!reportText(run.output)}>
                    <summary>结构化 JSON</summary>
                    <pre>{outputText(run.output)}</pre>
                  </details>
                </div>
              ) : null}
              {historyStep ? (
                <div className="step-history">
                  <div className="panel-heading">
                    <strong>
                      {run.steps.find((step) => step.id === historyStep)?.label}{" "}
                      · 会话
                    </strong>
                    <button
                      className="text-control"
                      onClick={() => {
                        historyRequest.current++;
                        setHistoryStep("");
                        setHistory(undefined);
                        setHistoryBusy(false);
                      }}
                    >
                      查看输出
                    </button>
                    <button
                      className="text-control"
                      disabled={historyBusy}
                      onClick={() => void openHistory(historyStep)}
                    >
                      刷新
                    </button>
                  </div>
                  {!history ? (
                    <div className="runtime-empty">
                      {historyBusy
                        ? "正在读取会话…"
                        : "会话读取失败，可点击刷新重试。"}
                    </div>
                  ) : (
                    <>
                      <small className="session-identifier">
                        {history.preset} · {history.sessionId}
                      </small>
                      {history.hasMore ? (
                        <button
                          className="tool-button"
                          disabled={historyBusy}
                          onClick={() => void loadOlderHistory()}
                        >
                          {historyBusy ? "读取中…" : "加载更早记录"}
                        </button>
                      ) : null}
                      {history.entries.length ? (
                        history.entries.map((entry) => (
                          <div key={entry.seq} className="history-entry">
                            <span>{entry.kind}</span>
                            <p>{entry.text}</p>
                          </div>
                        ))
                      ) : (
                        <p className="muted">暂无会话记录。</p>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 150,
    borderWidth: 1,
    borderRadius: 7,
    padding: 10,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: "19px",
  },
  schemaFields: { gap: 12 },
  schemaField: { gap: 7 },
  fieldHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  schemaInput: {
    minHeight: 34,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  schemaTextarea: { minHeight: 72, textAlignVertical: "top" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: {
    minHeight: 32,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  toggle: {
    minHeight: 34,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  toggleDot: { width: 8, height: 8, borderRadius: 4 },
});
