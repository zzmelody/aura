import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { fetch } from "expo/fetch";
import { Button as AuraButton, Label, useTheme } from "@aura/ui/components";
import { fonts } from "@aura/ui/theme";
import type {
  FlowCatalog,
  FlowHistory,
  FlowPhase,
  FlowRun,
  FlowRunSummary,
  SavedFlowDefinition,
} from "@aura/protocol/types";

const labels: Record<FlowPhase, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  skipped: "未执行",
};
const running = (phase?: FlowPhase) =>
  phase === "queued" || phase === "running";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "流程服务暂时不可用。";
function Button({
  label,
  ...props
}: Omit<React.ComponentProps<typeof AuraButton>, "children"> & {
  label: string;
}) {
  return <AuraButton {...props}>{label}</AuraButton>;
}
// An idempotency identifier, not a credential. Also works on native and LAN HTTP.
const requestId = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });

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
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      result?.message ||
        `流程服务连接失败（${response.status}）。请检查设置中的后端地址。`,
    );
  return result as T;
}

/** Display and commands only: no graph traversal, prompt assembly or scheduling. */
export function FlowsScreen({ endpoint }: { endpoint: string }) {
  const { colors } = useTheme();
  const [catalog, setCatalog] = useState<FlowCatalog>();
  const [definitionId, setDefinitionId] = useState("");
  const [configText, setConfigText] = useState("");
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<"demo" | "codex">("demo");
  const [runs, setRuns] = useState<FlowRunSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [run, setRun] = useState<FlowRun>();
  const [stepId, setStepId] = useState("");
  const [history, setHistory] = useState<FlowHistory>();
  const [historyError, setHistoryError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const submission = useRef<{ fingerprint: string; id: string } | undefined>(
    undefined,
  );
  const generation = useRef(0);
  const view = useRef({ selected, stepId, endpoint });
  view.current = { selected, stepId, endpoint };
  const definition = catalog?.definitions.find(
    (saved) => saved.definition.id === definitionId,
  );
  const chooseDefinition = (saved: SavedFlowDefinition) => {
    setDefinitionId(saved.definition.id);
    setConfigText(JSON.stringify(saved.definition, null, 2));
  };

  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setCatalog(undefined);
    setRuns([]);
    setBusy(false);
    setSelected("");
    setRun(undefined);
    setError("");
    Promise.all([
      api<FlowCatalog>(endpoint, "/catalog", undefined, abort.signal),
      api<FlowRunSummary[]>(endpoint, "/runs", undefined, abort.signal),
    ])
      .then(([next, list]) => {
        if (abort.signal.aborted) return;
        setCatalog(next);
        setRuns(list);
        if (next.definitions[0]) chooseDefinition(next.definitions[0]);
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(errorText(err));
      });
    return () => {
      abort.abort();
      generation.current++;
    };
  }, [endpoint, refresh]);

  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setRun(undefined);
    setStepId("");
    const poll = async () => {
      try {
        const [next, list] = await Promise.all([
          api<FlowRun>(endpoint, `/runs/${selected}`, undefined, abort.signal),
          api<FlowRunSummary[]>(endpoint, "/runs", undefined, abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setRun(next);
        setRuns(list);
        setError("");
        if (running(next.status)) timer = setTimeout(() => void poll(), 1200);
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(errorText(err));
          timer = setTimeout(() => void poll(), 4000);
        }
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [selected, endpoint]);

  useEffect(() => {
    setHistory(undefined);
    setHistoryError("");
    if (!selected || !stepId) return;
    const abort = new AbortController();
    setHistoryBusy(true);
    api<FlowHistory>(
      endpoint,
      `/runs/${selected}/steps/${stepId}/history`,
      undefined,
      abort.signal,
    )
      .then((next) => {
        if (!abort.signal.aborted) setHistory(next);
      })
      .catch((err) => {
        if (!abort.signal.aborted) setHistoryError(errorText(err));
      })
      .finally(() => {
        if (!abort.signal.aborted) setHistoryBusy(false);
      });
    return () => abort.abort();
  }, [selected, stepId, endpoint, run?.status]);

  const command = async (work: () => Promise<void>) => {
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      if (generation.current === epoch) setError(errorText(err));
    } finally {
      if (generation.current === epoch) setBusy(false);
    }
  };
  const start = () =>
    command(async () => {
      const epoch = generation.current;
      const fingerprint = JSON.stringify({
        endpoint,
        definitionId,
        task: task.trim(),
        mode,
      });
      if (submission.current?.fingerprint !== fingerprint)
        submission.current = { fingerprint, id: requestId() };
      const next = await api<FlowRun>(endpoint, "/runs", {
        requestId: submission.current.id,
        definitionId,
        task: task.trim(),
        mode,
      });
      if (generation.current !== epoch) return;
      submission.current = undefined;
      setSelected(next.id);
    });
  const save = () =>
    command(async () => {
      const epoch = generation.current;
      const saved = await api<SavedFlowDefinition>(
        endpoint,
        "/definitions",
        JSON.parse(configText),
      );
      const next = await api<FlowCatalog>(endpoint, "/catalog");
      if (generation.current !== epoch) return;
      setCatalog(next);
      chooseDefinition(saved);
      setEditing(false);
    });
  const olderHistory = async () => {
    if (!history?.hasMore || history.beforeSeq === undefined) return;
    const address = { ...view.current };
    setHistoryBusy(true);
    try {
      const older = await api<FlowHistory>(
        endpoint,
        `/runs/${selected}/steps/${stepId}/history?beforeSeq=${history.beforeSeq}`,
      );
      if (JSON.stringify(view.current) !== JSON.stringify(address)) return;
      setHistory((current) =>
        current
          ? { ...older, entries: [...older.entries, ...current.entries] }
          : older,
      );
    } catch (err) {
      if (JSON.stringify(view.current) === JSON.stringify(address))
        setHistoryError(errorText(err));
    } finally {
      if (JSON.stringify(view.current) === JSON.stringify(address))
        setHistoryBusy(false);
    }
  };

  const textStyle = { color: colors.text, fontFamily: fonts.body };
  const muted = { color: colors.secondary };
  const card = [
    styles.card,
    { borderColor: colors.border, backgroundColor: colors.surface },
  ];
  const input = [
    styles.input,
    textStyle,
    { borderColor: colors.border, backgroundColor: colors.background },
  ];
  const step = run?.steps.find((node) => node.id === stepId);
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 10 }}>
        <Label color={colors.accent}>AGENT WORKFLOWS</Label>
        <Text style={[textStyle, styles.title]}>各自思考，一起交付。</Text>
        <Text style={[styles.copy, muted]}>
          独立 preset · 独立会话 · 一份最终报告{"\n"}
          流程在后端运行，离开页面不会中止执行。
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : null}
      {!catalog ? (
        <View style={styles.row}>
          <ActivityIndicator color={colors.accent} />
          <Button
            compact
            secondary
            label="重新连接"
            onPress={() => setRefresh((v) => v + 1)}
          />
        </View>
      ) : (
        <View style={card}>
          <View style={styles.row}>
            <Label>01 / 配置与任务</Label>
            <Button
              compact
              secondary
              label={editing ? "收起配置" : "编辑流程 JSON"}
              onPress={() => setEditing((v) => !v)}
            />
          </View>
          <View style={styles.row}>
            {catalog.definitions.map((saved) => (
              <Button
                key={saved.definition.id}
                compact
                secondary={definitionId !== saved.definition.id}
                label={saved.definition.name}
                onPress={() => chooseDefinition(saved)}
              />
            ))}
          </View>
          {editing ? (
            <>
              <Text style={[styles.copy, muted]}>
                修改节点的 preset、dependsOn 和 coordinator.sources。更改 id
                可保存为新流程；已开始的运行保留定义快照。校验与执行均由后端负责。
              </Text>
              <Text style={[styles.small, muted]}>
                可用 preset：
                {catalog.presets
                  .filter((preset) => !preset.unavailable)
                  .map((preset) => preset.id)
                  .join(" · ")}
              </Text>
              <TextInput
                accessibilityLabel="流程 JSON 配置"
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                value={configText}
                onChangeText={setConfigText}
                style={[input, styles.code]}
              />
              <Button
                compact
                label="保存流程配置"
                disabled={busy}
                onPress={() => void save()}
              />
            </>
          ) : (
            <View style={styles.row}>
              {definition?.definition.nodes.map((node) => (
                <View
                  key={node.id}
                  style={[styles.node, { backgroundColor: colors.soft }]}
                >
                  <Text style={textStyle}>{node.label}</Text>
                  <Text style={[styles.mono, muted]}>{node.preset}</Text>
                  <Text style={[styles.small, muted]}>
                    依赖：{node.dependsOn.join("、") || "无"}
                  </Text>
                </View>
              ))}
              <Text style={{ color: colors.accent }}>→</Text>
              <View
                style={[
                  styles.node,
                  { borderColor: colors.accent, borderWidth: 1 },
                ]}
              >
                <Text style={textStyle}>最终报告</Text>
                <Text style={[styles.mono, muted]}>
                  {definition?.definition.coordinator.preset}
                </Text>
                <Text style={[styles.small, muted]}>
                  来源：{definition?.definition.coordinator.sources.join("、")}
                </Text>
              </View>
            </View>
          )}
          <TextInput
            accessibilityLabel="流程任务"
            placeholder="这次，希望团队一起完成什么？"
            placeholderTextColor={colors.muted}
            multiline
            value={task}
            onChangeText={setTask}
            style={[input, { minHeight: 95 }]}
          />
          <View style={styles.row}>
            <Button
              compact
              secondary={mode !== "demo"}
              label="DSH 演示"
              onPress={() => setMode("demo")}
            />
            <Button
              compact
              secondary={mode !== "codex"}
              label="Codex 真实模型"
              onPress={() => setMode("codex")}
            />
            <Button
              compact
              label={busy ? "正在提交…" : "运行流程"}
              disabled={busy || !task.trim() || !definitionId}
              onPress={() => void start()}
            />
          </View>
          <Text style={[styles.small, muted]}>
            {mode === "demo"
              ? "演示模式经过真实 DSH 会话，内容由本地规则模型生成，不消耗订阅额度。"
              : "将为各节点和 coordinator 调用 Codex，使用已登录账号的额度。请先在顶部完成登录。"}
          </Text>
        </View>
      )}
      <View style={{ gap: 12 }}>
        <View style={styles.row}>
          <Label>02 / 运行记录</Label>
          <Button
            compact
            secondary
            label="刷新记录"
            disabled={busy}
            onPress={() =>
              void command(async () =>
                setRuns(await api<FlowRunSummary[]>(endpoint, "/runs")),
              )
            }
          />
        </View>
        {!runs.length ? (
          <Text style={muted}>
            开始一次运行后，步骤、会话和报告会保存在这里。
          </Text>
        ) : null}
        {runs.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`查看运行：${item.task}`}
            onPress={() => setSelected(item.id)}
            style={[
              styles.runRow,
              {
                borderColor:
                  selected === item.id ? colors.accent : colors.border,
                backgroundColor:
                  selected === item.id ? colors.soft : "transparent",
              },
            ]}
          >
            <View style={{ flex: 1, gap: 5 }}>
              <Text numberOfLines={1} style={textStyle}>
                {item.task}
              </Text>
              <Text style={[styles.small, muted]}>
                {item.name} · {item.mode === "demo" ? "演示" : "Codex"} ·{" "}
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </Text>
            </View>
            <Text style={{ color: colors.accent }}>{labels[item.status]}</Text>
          </Pressable>
        ))}
      </View>
      {selected && !run ? <ActivityIndicator color={colors.accent} /> : null}
      {run ? (
        <>
          <View style={card}>
            <View style={styles.row}>
              <Label color={colors.accent}>
                FINAL REPORT / {labels[run.status]}
              </Label>
              {running(run.status) ? (
                <Button
                  compact
                  secondary
                  label="取消运行"
                  disabled={busy}
                  onPress={() =>
                    void command(async () => {
                      await api(endpoint, `/runs/${run.id}/cancel`, {});
                    })
                  }
                />
              ) : null}
            </View>
            <Text selectable style={[styles.copy, textStyle]}>
              {run.report ||
                run.error ||
                (running(run.status)
                  ? "节点正在执行。所有节点成功完成后，coordinator 将汇总选定输出。"
                  : "本次运行未生成最终报告。已完成的节点输出仍可查看。")}
            </Text>
            <Text selectable style={[styles.mono, muted]}>
              RUN {run.id} · 配置 v{run.revision}
            </Text>
          </View>
          <View style={card}>
            <Label>03 / 步骤与 DSH 会话</Label>
            {run.steps.map((node, index) => (
              <Pressable
                key={node.id}
                accessibilityRole="button"
                accessibilityLabel={`查看 ${node.label} 会话`}
                onPress={() => setStepId(node.id)}
                style={[
                  styles.stepRow,
                  {
                    borderColor: colors.border,
                    backgroundColor:
                      stepId === node.id ? colors.soft : "transparent",
                  },
                ]}
              >
                <Text style={[styles.mono, { color: colors.accent }]}>
                  {String(index + 1).padStart(2, "0")}
                </Text>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={textStyle}>
                    {node.label} · {labels[node.status]}
                  </Text>
                  <Text selectable style={[styles.mono, muted]}>
                    {node.preset}
                    {"\n"}
                    {node.sessionId}
                  </Text>
                  {node.error ? (
                    <Text style={{ color: colors.danger }}>{node.error}</Text>
                  ) : null}
                </View>
                <Text style={{ color: colors.accent }}>↗</Text>
              </Pressable>
            ))}
          </View>
          {step ? (
            <View style={card}>
              <Label>{step.label} / SESSION</Label>
              {step.output ? (
                <Text selectable style={[styles.copy, textStyle]}>
                  {step.output}
                </Text>
              ) : null}
              <Text style={[styles.small, muted]}>
                以下内容由 DSH
                历史接口读取。工具调用显示名称与状态，完整工具结果保留在后端 DSH
                日志。
              </Text>
              {historyError ? (
                <Text
                  accessibilityRole="alert"
                  style={{ color: colors.danger }}
                >
                  {historyError}
                </Text>
              ) : null}
              {history?.hasMore ? (
                <Button
                  compact
                  secondary
                  label="加载更早内容"
                  disabled={historyBusy}
                  onPress={() => void olderHistory()}
                />
              ) : null}
              {historyBusy ? <ActivityIndicator color={colors.accent} /> : null}
              {history?.entries.map((entry) => (
                <View
                  key={entry.seq}
                  style={[styles.transcript, { borderColor: colors.border }]}
                >
                  <Label>
                    {entry.kind.toUpperCase()} · #{entry.seq}
                  </Label>
                  <Text selectable style={[styles.copy, textStyle]}>
                    {entry.text || "（无文本内容）"}
                  </Text>
                </View>
              ))}
              {history && !history.entries.length ? (
                <Text style={muted}>这个步骤尚无会话内容。</Text>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, gap: 28, paddingBottom: 64 },
  title: {
    fontFamily: fonts.display,
    fontSize: 29,
    lineHeight: 40,
    letterSpacing: -0.8,
  },
  copy: { fontSize: 14, lineHeight: 24 },
  small: { fontSize: 12, lineHeight: 19 },
  mono: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 18 },
  card: { borderWidth: 1, borderRadius: 18, padding: 20, gap: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
  },
  node: { padding: 12, borderRadius: 10, gap: 5, minWidth: 130 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    lineHeight: 23,
    textAlignVertical: "top",
  },
  code: {
    minHeight: 310,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 20,
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    padding: 12,
    gap: 12,
    borderRadius: 8,
  },
  transcript: { borderTopWidth: 1, paddingTop: 16, gap: 10 },
});
