import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
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
import {
  Button,
  Label,
  Reveal,
  SectionHeading,
  useTheme,
} from "@aura/ui/components";
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
  endpointRef.current = endpoint;

  async function refresh(signal?: AbortSignal) {
    const [nextCatalog, nextRuns] = await Promise.all([
      api<FlowCatalog>(endpoint, "/catalog", undefined, signal),
      api<FlowRunSummary[]>(endpoint, "/runs", undefined, signal),
    ]);
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
      JSON.stringify(schemaInitialValue(selectedFlow.inputSchema), null, 2),
    );
  }, [selectedFlow?.id]);

  useEffect(() => {
    if (!selectedId) {
      setRun(undefined);
      return;
    }
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
  }, [selectedId, runRevision]);

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
    setHistoryStep(stepId);
    setHistory(undefined);
    setError("");
    setHistoryBusy(true);
    try {
      setHistory(
        await api<FlowHistory>(
          endpoint,
          `/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(stepId)}/history`,
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setHistoryBusy(false);
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
    setHistoryBusy(true);
    setError("");
    try {
      const older = await api<FlowHistory>(
        endpoint,
        `/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(historyStep)}/history?beforeSeq=${beforeSeq}`,
      );
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
      setError(errorText(cause));
    } finally {
      setHistoryBusy(false);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Reveal>
        <Label>AGENT WORKFLOWS</Label>
        <Text style={[textType.title, { color: colors.text, marginTop: 14 }]}>
          把复杂任务，交给一组 Agent。
        </Text>
        <Text
          style={[
            textType.body,
            { color: colors.secondary, marginTop: 8, marginBottom: 28 },
          ]}
        >
          Flow 由后端代码定义，DSH 负责会话、模型、取消和运行记录。
        </Text>
      </Reveal>

      {error ? (
        <Text
          accessibilityRole="alert"
          style={[
            styles.notice,
            { color: colors.danger, borderColor: colors.danger },
          ]}
        >
          {error}
        </Text>
      ) : null}

      {!catalog ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[textType.small, { color: colors.muted }]}>
            正在读取 Flow 目录
          </Text>
        </View>
      ) : (
        <>
          <SectionHeading title="选择 Flow" meta="01 / CATALOG" />
          <View style={styles.catalog}>
            {catalog.flows.map((flow) => {
              const chosen = flow.id === flowId;
              return (
                <Pressable
                  key={flow.id}
                  accessibilityRole="radio"
                  accessibilityLabel={flow.title}
                  accessibilityState={{
                    checked: chosen,
                    disabled: !flow.available,
                  }}
                  disabled={!flow.available}
                  onPress={() => setFlowId(flow.id)}
                  style={({ pressed }) => [
                    styles.flowCard,
                    {
                      backgroundColor: chosen ? colors.soft : colors.surface,
                      borderColor: chosen ? colors.accent : colors.border,
                      opacity: !flow.available ? 0.5 : pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <View style={styles.cardTop}>
                    <GitBranch
                      size={20}
                      color={chosen ? colors.accent : colors.muted}
                    />
                    <Label color={chosen ? colors.accent : colors.muted}>
                      {flow.available ? "READY" : "UNAVAILABLE"}
                    </Label>
                  </View>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>
                    {flow.title}
                  </Text>
                  <Text
                    style={[
                      textType.small,
                      { color: colors.secondary, marginTop: 7 },
                    ]}
                  >
                    {flow.description}
                  </Text>
                  {flow.sourceHash ? (
                    <Text style={[styles.hash, { color: colors.muted }]}>
                      {flow.id} · {flow.sourceHash.slice(0, 10)}
                    </Text>
                  ) : null}
                  {flow.error ? (
                    <Text
                      style={[
                        textType.small,
                        { color: colors.danger, marginTop: 8 },
                      ]}
                    >
                      {flow.error}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          <View style={{ marginTop: 30 }}>
            <SectionHeading title="运行参数" meta="02 / INPUT" />
            <View
              style={[
                styles.editor,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <Text style={[textType.small, { color: colors.secondary }]}>
                {selectedFlow?.title ?? "请选择可用 Flow"} · Schema 参数
              </Text>
              {selectedFlow?.inputSchema && !parsed.error ? (
                <SchemaInputEditor
                  schemaValue={selectedFlow.inputSchema}
                  value={parsed.value}
                  onChange={(next) => setInput(JSON.stringify(next, null, 2))}
                />
              ) : null}
              <Label color={colors.muted}>RAW JSON</Label>
              <TextInput
                accessibilityLabel="Flow JSON 输入"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                onChangeText={setInput}
                placeholder={'{ "task": "描述要完成的任务" }'}
                placeholderTextColor={colors.muted}
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.input,
                    borderColor: parsed.error ? colors.danger : colors.border,
                    color: colors.text,
                  },
                ]}
                value={input}
              />
              {parsed.error ? (
                <Text style={[textType.small, { color: colors.danger }]}>
                  {parsed.error}
                </Text>
              ) : null}
              <View style={styles.modeRow}>
                {(["demo", "codex"] as const).map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: mode === value }}
                    onPress={() => setMode(value)}
                    style={[
                      styles.mode,
                      {
                        backgroundColor:
                          mode === value ? colors.soft : colors.input,
                        borderColor:
                          mode === value ? colors.accent : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        textType.small,
                        {
                          color:
                            mode === value ? colors.accent : colors.secondary,
                        },
                      ]}
                    >
                      {value === "demo" ? "DSH 演示" : "Codex 订阅"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Button
                disabled={
                  !selectedFlow?.available || Boolean(parsed.error) || busy
                }
                icon={Play}
                onPress={() => void start()}
              >
                {busy ? "正在提交…" : "开始运行"}
              </Button>
            </View>
          </View>
        </>
      )}

      <View style={{ marginTop: 30 }}>
        <SectionHeading
          title="最近运行"
          meta={`${runs.length}`.padStart(2, "0")}
        />
        {!runs.length ? (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Clock3 size={19} color={colors.muted} />
            <Text style={[textType.small, { color: colors.muted }]}>
              运行记录会出现在这里。
            </Text>
          </View>
        ) : (
          runs.map((item) => (
            <Pressable
              key={item.id}
              accessibilityLabel={`查看运行：${item.title}`}
              onPress={() => {
                setSelectedId(item.id);
                setHistory(undefined);
                setHistoryStep("");
              }}
              style={({ pressed }) => [
                styles.runRow,
                {
                  borderColor: colors.border,
                  backgroundColor:
                    selectedId === item.id ? colors.soft : "transparent",
                  opacity: pressed ? 0.65 : 1,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.runTitle, { color: colors.text }]}>
                  {item.title}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[
                    textType.small,
                    { color: colors.muted, marginTop: 4 },
                  ]}
                >
                  {item.inputPreview} ·{" "}
                  {item.mode === "codex" ? "CODEX" : "DEMO"}
                </Text>
              </View>
              <Label color={active(item.status) ? colors.accent : colors.muted}>
                {phaseLabels[item.status]}
              </Label>
              <ChevronRight size={16} color={colors.muted} />
            </Pressable>
          ))
        )}
      </View>

      {selectedId ? (
        <View style={{ marginTop: 30 }}>
          <SectionHeading title="运行详情" meta="03 / RESULT" />
          {!run ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <View
              style={[
                styles.detail,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={styles.detailHead}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>
                    {run.flow.title}
                  </Text>
                  <Text
                    style={[
                      textType.small,
                      { color: colors.muted, marginTop: 5 },
                    ]}
                  >
                    {phaseLabels[run.status]} ·{" "}
                    {new Date(run.createdAt).toLocaleString("zh-CN")}
                  </Text>
                  <Text style={[styles.hash, { color: colors.muted }]}>
                    {run.flow.id} · {run.flow.sourceHash.slice(0, 10)}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="刷新运行状态"
                  onPress={() => setRunRevision((value) => value + 1)}
                  style={styles.refresh}
                >
                  <RefreshCw size={16} color={colors.accent} />
                </Pressable>
              </View>
              {active(run.status) ? (
                <Button
                  secondary
                  compact
                  disabled={busy}
                  icon={Square}
                  onPress={() => void cancel()}
                >
                  停止运行
                </Button>
              ) : null}
              <View style={styles.steps}>
                {run.steps.map((step) => (
                  <Pressable
                    key={step.id}
                    accessibilityLabel={`查看 ${step.label} 会话`}
                    onPress={() => void openHistory(step.id)}
                    style={[
                      styles.step,
                      {
                        backgroundColor:
                          historyStep === step.id ? colors.soft : colors.input,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.dot,
                        {
                          backgroundColor:
                            step.status === "completed"
                              ? colors.success
                              : active(step.status)
                                ? colors.accent
                                : colors.muted,
                        },
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[textType.body, { color: colors.text }]}>
                        {step.label}
                      </Text>
                      <Text style={[textType.small, { color: colors.muted }]}>
                        {step.preset} · {phaseLabels[step.status]}
                      </Text>
                      <Text
                        selectable
                        style={[styles.sessionId, { color: colors.muted }]}
                      >
                        session {step.sessionId}
                      </Text>
                    </View>
                    <ChevronRight size={15} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
              {run.error ? (
                <Text style={[textType.small, { color: colors.danger }]}>
                  {run.error}
                </Text>
              ) : null}
              {run.output !== undefined ? (
                <View
                  style={[
                    styles.output,
                    {
                      backgroundColor: colors.input,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Label>FLOW OUTPUT</Label>
                  {reportText(run.output) ? (
                    <Text
                      selectable
                      style={[
                        textType.body,
                        styles.preformatted,
                        { color: colors.text, marginTop: 10 },
                      ]}
                    >
                      {reportText(run.output)}
                    </Text>
                  ) : null}
                  <Label color={colors.muted}>STRUCTURED JSON</Label>
                  <Text
                    selectable
                    style={[styles.jsonOutput, { color: colors.secondary }]}
                  >
                    {outputText(run.output)}
                  </Text>
                </View>
              ) : null}
              {historyStep ? (
                <View style={[styles.output, { borderColor: colors.border }]}>
                  <Label>SESSION HISTORY / {historyStep.toUpperCase()}</Label>
                  {!history ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : history.entries.length ? (
                    <>
                      <Text
                        selectable
                        style={[styles.sessionId, { color: colors.muted }]}
                      >
                        {history.preset} · session {history.sessionId}
                      </Text>
                      {history.hasMore ? (
                        <Button
                          compact
                          secondary
                          disabled={historyBusy}
                          onPress={() => void loadOlderHistory()}
                        >
                          {historyBusy ? "读取中…" : "加载更早记录"}
                        </Button>
                      ) : null}
                      {history.entries.map((entry) => (
                        <View key={entry.seq} style={{ marginTop: 12 }}>
                          <Label
                            color={
                              entry.kind === "assistant"
                                ? colors.accent
                                : colors.muted
                            }
                          >
                            {entry.kind.toUpperCase()}
                          </Label>
                          <Text
                            style={[
                              textType.small,
                              { color: colors.secondary, marginTop: 4 },
                            ]}
                          >
                            {entry.text}
                          </Text>
                        </View>
                      ))}
                    </>
                  ) : (
                    <Text
                      style={[
                        textType.small,
                        { color: colors.muted, marginTop: 10 },
                      ]}
                    >
                      暂无可展示的会话记录。
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: 24,
    paddingBottom: 40,
    width: "100%",
    maxWidth: 900,
    alignSelf: "center",
  },
  notice: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  loading: {
    minHeight: 100,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  catalog: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  flowCard: {
    flex: 1,
    minWidth: 240,
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: {
    fontFamily: fonts.medium,
    fontWeight: 500,
    fontSize: 15,
    marginTop: 18,
  },
  hash: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: "16px",
    marginTop: 8,
  },
  editor: { borderWidth: 1, borderRadius: 18, padding: 18, gap: 14 },
  input: {
    minHeight: 116,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: "19px",
  },
  modeRow: { flexDirection: "row", gap: 10 },
  mode: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    minHeight: 72,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  runRow: {
    minHeight: 72,
    padding: 14,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  runTitle: { fontFamily: fonts.medium, fontWeight: 500, fontSize: 14 },
  detail: { borderWidth: 1, borderRadius: 18, padding: 18, gap: 16 },
  detailHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  refresh: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  steps: { gap: 10 },
  step: {
    minHeight: 64,
    borderWidth: 1,
    borderRadius: 14,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  output: { borderWidth: 1, borderRadius: 14, padding: 16 },
  schemaFields: { gap: 14 },
  schemaField: { gap: 7 },
  fieldHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  schemaInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  schemaTextarea: { minHeight: 96, textAlignVertical: "top" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: {
    minHeight: 38,
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  toggle: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  toggleDot: { width: 8, height: 8, borderRadius: 4 },
  sessionId: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: "16px",
    marginTop: 3,
  },
  preformatted: { whiteSpace: "pre-wrap" },
  jsonOutput: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: "18px",
    marginTop: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
});
