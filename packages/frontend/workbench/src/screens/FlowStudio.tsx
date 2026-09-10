import React, { useEffect, useRef, useState } from "react";
import {
  Braces,
  Check,
  Download,
  FileCode2,
  Play,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { FlowsScreen } from "./Flows";
import type { FlowDraftController } from "../flowDraft";

export function FlowStudio({
  endpoint,
  draft,
  editorRevision,
  onAsk,
}: {
  endpoint: string;
  draft: FlowDraftController;
  editorRevision: number;
  onAsk(): void;
}) {
  const [view, setView] = useState<"editor" | "runs">("editor");
  const [notice, setNotice] = useState("");
  const [line, setLine] = useState(1);
  const file = useRef<HTMLInputElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editorRevision) {
      setView("editor");
      setNotice("已将助手代码放入草稿，可继续编辑或撤销。 ");
    }
  }, [editorRevision]);
  function download() {
    const url = URL.createObjectURL(
      new Blob([draft.code], { type: "text/javascript;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "my-flow.flow.js";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      "已导出 my-flow.flow.js。注册到后端后，可在「运行与记录」中选择。 ",
    );
  }
  return (
    <section className="flow-studio" aria-label="Flow 编辑与运行">
      <div className="studio-tabs" role="tablist" aria-label="Flow 工作区视图">
        <button
          id="editor-tab"
          role="tab"
          aria-selected={view === "editor"}
          aria-controls="editor-panel"
          onClick={() => setView("editor")}
        >
          <FileCode2 size={15} />
          代码草稿
          <span className="tab-dot" />
        </button>
        <button
          id="runs-tab"
          role="tab"
          aria-selected={view === "runs"}
          aria-controls="runs-panel"
          onClick={() => setView("runs")}
        >
          <Play size={14} />
          运行与记录
        </button>
        <span className="studio-tab-meta">FLOW STUDIO</span>
      </div>
      <div
        id="editor-panel"
        role="tabpanel"
        aria-labelledby="editor-tab"
        className="editor-panel"
        hidden={view !== "editor"}
      >
        <div className="editor-toolbar">
          <div className="editor-filename">
            <Braces size={15} />
            <strong>my-flow.flow.js</strong>
            <span className="badge">本地草稿</span>
          </div>
          <div className="editor-actions">
            <button
              className="icon-control"
              aria-label="撤销替换草稿"
              title="撤销助手替换或导入"
              disabled={!draft.canUndo}
              onClick={() => {
                draft.undo();
                setNotice("已恢复替换前的草稿。");
              }}
            >
              <Undo2 size={15} />
            </button>
            <button
              className="tool-button"
              onClick={() => file.current?.click()}
            >
              <Upload size={14} />
              <span>导入</span>
            </button>
            <button
              className="tool-button"
              disabled={!draft.code.trim()}
              onClick={download}
            >
              <Download size={14} />
              <span>导出</span>
            </button>
          </div>
        </div>
        <input
          type="file"
          hidden
          ref={file}
          accept=".js,.ts,.txt"
          aria-label="导入 Flow 文件"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (selected.size > 100_000) {
              setNotice("请选择小于 100 KB 的 Flow 文件。");
              return;
            }
            try {
              draft.update(await selected.text());
              setNotice(`已导入 ${selected.name}，可撤销本次替换。`);
            } catch {
              setNotice("文件读取失败，请重试。");
            }
          }}
        />
        <div className="editor-intro">
          <div>
            <span className="eyebrow">从想法到流程</span>
            <h1>编排你的下一步。</h1>
            <p>直接编辑代码，或让生成助手帮你拆解任务、编写 Flow。</p>
          </div>
          <button className="tool-button accent" onClick={onAsk}>
            <Sparkles size={15} />
            让助手完善
          </button>
        </div>
        {notice || draft.saveError ? (
          <div
            className="editor-notice"
            role={draft.saveError ? "alert" : "status"}
          >
            <span>{draft.saveError || notice}</span>
            {notice ? (
              <button className="text-control" onClick={() => setNotice("")}>
                收起
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="code-editor">
          <div className="code-gutter" ref={gutter} aria-hidden="true">
            {draft.code.split("\n").map((_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
          <textarea
            className="flow-code"
            aria-label="Flow 代码编辑器"
            spellCheck={false}
            value={draft.code}
            onChange={(event) => draft.edit(event.target.value)}
            onScroll={(event) => {
              if (gutter.current)
                gutter.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onSelect={(event) =>
              setLine(
                event.currentTarget.value
                  .slice(0, event.currentTarget.selectionStart)
                  .split("\n").length,
              )
            }
            onKeyDown={(event) => {
              if (event.key !== "Tab" || event.shiftKey) return;
              event.preventDefault();
              const element = event.currentTarget;
              const start = element.selectionStart;
              const end = element.selectionEnd;
              draft.edit(
                `${draft.code.slice(0, start)}  ${draft.code.slice(end)}`,
              );
              requestAnimationFrame(() => {
                element.selectionStart = element.selectionEnd = start + 2;
              });
            }}
          />
        </div>
        <div className="editor-status">
          <span>
            <Check size={12} />
            {draft.saveError
              ? "保存失败"
              : draft.saved
                ? "草稿已保存到本机"
                : "保存中…"}
          </span>
          <span>Ln {line} · JavaScript · UTF-8</span>
        </div>
        <div className="draft-note">
          草稿可编辑、导出。运行已注册的 Flow，请切换到「运行与记录」。
          <span>Tab 缩进 · Shift+Tab 离开编辑器</span>
        </div>
      </div>
      <div
        id="runs-panel"
        role="tabpanel"
        aria-labelledby="runs-tab"
        className="runs-panel"
        hidden={view !== "runs"}
      >
        <FlowsScreen endpoint={endpoint} />
      </div>
    </section>
  );
}
