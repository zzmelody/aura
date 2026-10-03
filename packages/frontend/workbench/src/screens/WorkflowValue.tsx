import React, { memo, useEffect, useState } from "react";
import { Check, Copy, FileAudio, FileImage, FileVideo, File } from "lucide-react";
import { writeClipboard } from "../clipboard";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JsonValue } from "@aura/protocol/types";
import { asObject } from "./WorkflowInput";

const plugins = [remarkGfm];
const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div
      className="workflow-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="数据表格"
    >
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }) => <img src={src} alt={alt ?? ""} loading="lazy" />,
};

export const WorkflowRichText = memo(function WorkflowRichText({
  text,
}: {
  text: string;
}) {
  return (
    <div className="workflow-rich-text">
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
});

const labels: Record<string, string> = {
  task: "任务",
  report: "报告",
  text: "内容",
  summary: "摘要",
  result: "结果",
  title: "标题",
  description: "说明",
  items: "条目",
  count: "数量",
  status: "状态",
  success: "成功",
  error: "错误",
  message: "消息",
  output: "输出",
  input: "输入",
  statistics: "统计",
  characters: "字符数",
  lines: "行数",
  metrics: "指标",
  audience: "适用人群",
  duration: "时长",
  durationSeconds: "时长（秒）",
  audioPath: "音频文件",
  videoPath: "视频文件",
  imagePath: "图片文件",
  imageAssetId: "图片资产 ID",
  engine: "生成引擎",
  model: "模型",
  note: "说明",
  seed: "随机种子",
  modelPath: "模型文件",
  files: "文件",
  speaker: "音色",
  language: "语言",
  narration: "旁白",
  visualPrompt: "画面提示词",
};

/** Absolute local file paths (Windows drive or POSIX) with a file extension. */
export function isLocalFilePath(value: string) {
  return (
    value.length <= 1024 &&
    !value.includes("\n") &&
    /^(?:[a-zA-Z]:[\\/]|\/)[^<>"|?*\n]*\.[a-zA-Z0-9]{2,5}$/u.test(value.trim())
  );
}

const fileIcon = (name: string) =>
  /\.(wav|mp3|m4a|flac|ogg)$/iu.test(name)
    ? FileAudio
    : /\.(mp4|mov|webm)$/iu.test(name)
      ? FileVideo
      : /\.(png|jpe?g|webp|gif)$/iu.test(name)
        ? FileImage
        : File;

/** A path is a location, not content: show the name, keep the path copyable. */
function FilePathChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const parts = path.split(/[\\/]/u);
  const name = parts.at(-1) ?? path;
  const folder = parts.slice(-3, -1).join("/");
  const Icon = fileIcon(name);
  return (
    <span className="workflow-file-chip" title={path}>
      <Icon size={14} aria-hidden="true" />
      <span className="workflow-file-name">{name}</span>
      {folder ? <span className="workflow-file-folder">…/{folder}</span> : null}
      <button
        type="button"
        className="icon-control"
        aria-label={copied ? "已复制路径" : `复制 ${name} 的本地路径`}
        title={copied ? "已复制" : "复制本地路径"}
        onClick={() =>
          void writeClipboard(path)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}
function labelFor(key: string, schema?: JsonValue) {
  const spec = asObject(schema);
  return typeof spec?.title === "string" ? spec.title : (labels[key] ?? key);
}

/** Structured data stays readable; JSON remains available separately for inspection. */
export function WorkflowValue({
  value,
  schema,
  depth = 0,
}: {
  value: JsonValue | undefined;
  schema?: JsonValue;
  depth?: number;
}) {
  if (value === undefined || value === null || value === "")
    return <span className="workflow-value-empty">未提供</span>;
  if (typeof value === "string")
    return isLocalFilePath(value) ? (
      <FilePathChip path={value.trim()} />
    ) : (
      <WorkflowRichText text={value} />
    );
  if (typeof value === "boolean")
    return (
      <span className="workflow-value-boolean">{value ? "是" : "否"}</span>
    );
  if (typeof value === "number")
    return (
      <span className="workflow-value-number">{value}</span>
    );
  if (depth >= 5)
    return (
      <details className="workflow-data-overflow">
        <summary>展开嵌套数据</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  if (Array.isArray(value)) {
    if (!value.length)
      return <span className="workflow-value-empty">暂无条目</span>;
    const columns = [
      ...new Set(value.flatMap((row) => Object.keys(asObject(row) ?? {}))),
    ];
    const tabular =
      columns.length > 0 &&
      columns.length <= 8 &&
      value.every((row) => {
        const record = asObject(row);
        return (
          record &&
          Object.values(record).every(
            (cell) => cell === null || typeof cell !== "object",
          )
        );
      });
    if (tabular)
      return (
        <div
          className="workflow-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="数据表格"
        >
          <table>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key} scope="col">
                    {labelFor(
                      key,
                      asObject(asObject(asObject(schema)?.items)?.properties)?.[
                        key
                      ],
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>
                      <WorkflowValue
                        value={asObject(row)?.[key]}
                        depth={depth + 1}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    return (
      <ol className="workflow-value-list">
        {value.map((item, index) => (
          <li key={index}>
            <WorkflowValue
              value={item}
              schema={asObject(schema)?.items}
              depth={depth + 1}
            />
          </li>
        ))}
      </ol>
    );
  }
  const fields = Object.entries(value);
  if (!fields.length)
    return <span className="workflow-value-empty">暂无字段</span>;
  const properties = asObject(asObject(schema)?.properties);
  const metrics = fields.every(
    ([, item]) => typeof item === "number" || typeof item === "boolean",
  );
  return (
    <dl
      className={`workflow-value-fields${metrics ? " workflow-value-metrics" : ""}`}
    >
      {fields.map(([key, item]) => (
        <div className="workflow-value-field" key={key}>
          <dt>{labelFor(key, properties?.[key])}</dt>
          <dd>
            <WorkflowValue
              value={item}
              schema={properties?.[key]}
              depth={depth + 1}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WorkflowData({
  value,
  schema,
}: {
  value: JsonValue | undefined;
  schema?: JsonValue;
}) {
  return (
    <div className="workflow-data">
      <WorkflowValue value={value} schema={schema} />
      {value !== undefined ? <WorkflowJson value={value} /> : null}
    </div>
  );
}

export function WorkflowJson({ value }: { value: JsonValue }) {
  const [raw, setRaw] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="text-control workflow-json-toggle"
        aria-expanded={raw}
        onClick={() => setRaw(!raw)}
      >
        {raw ? "收起 JSON" : "查看 JSON"}
      </button>
      {raw ? (
        <pre className="workflow-raw-output">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </>
  );
}
