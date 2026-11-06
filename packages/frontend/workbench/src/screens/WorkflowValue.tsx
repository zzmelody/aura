import React, { memo, useEffect, useState } from "react";
import {
  useWorkflowMessages,
  workflowText,
  type WorkflowMessageKey,
} from "../workflow-messages.ts";
import { formatNumber } from "@aura/i18n/runtime";
import {
  Check,
  Copy,
  FileAudio,
  FileImage,
  FileVideo,
  File,
} from "lucide-react";
import { writeClipboard } from "../clipboard";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JsonValue } from "@aura/protocol/types";
import { asObject } from "./WorkflowInput";
import { metadataText } from "../metadata.ts";

const plugins = [remarkGfm];
function WorkflowTable({ children }: { children?: React.ReactNode }) {
  const { t } = useWorkflowMessages();
  return (
    <div
      className="workflow-table-scroll"
      tabIndex={0}
      role="region"
      aria-label={t("dataTable")}
    >
      <table>{children}</table>
    </div>
  );
}
const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: WorkflowTable,
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

const labels: Record<string, WorkflowMessageKey> = {
  task: "valueTask",
  report: "valueReport",
  text: "valueText",
  summary: "valueSummary",
  result: "valueResult",
  title: "valueTitle",
  description: "valueDescription",
  items: "valueItems",
  count: "valueCount",
  status: "valueStatus",
  success: "valueSuccess",
  error: "valueError",
  message: "valueMessage",
  output: "output",
  input: "input",
  statistics: "valueStatistics",
  characters: "valueCharacters",
  lines: "valueLines",
  metrics: "valueMetrics",
  audience: "valueAudience",
  duration: "valueDuration",
  durationSeconds: "valueDurationSeconds",
  audioPath: "valueAudioPath",
  videoPath: "valueVideoPath",
  imagePath: "valueImagePath",
  imageAssetId: "valueImageAssetId",
  engine: "valueEngine",
  model: "model",
  note: "valueDescription",
  seed: "valueSeed",
  modelPath: "valueModelPath",
  files: "valueFiles",
  speaker: "valueSpeaker",
  language: "valueLanguage",
  narration: "fieldNarration",
  visualPrompt: "valueVisualPrompt",
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
  const { t } = useWorkflowMessages();
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
        aria-label={copied ? t("copiedPath") : t("copyNamedPath", { name })}
        title={copied ? t("copied") : t("copyLocalPath")}
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
function labelFor(
  key: string,
  schema?: JsonValue,
  runtime?: Parameters<typeof metadataText>[3],
) {
  const spec = asObject(schema);
  const fallback =
    typeof spec?.title === "string"
      ? spec.title
      : labels[key]
        ? workflowText(labels[key])
        : key;
  return metadataText(spec, "title", fallback, runtime);
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
  const { t, i18n } = useWorkflowMessages();
  if (value === undefined || value === null || value === "")
    return <span className="workflow-value-empty">{t("notProvided")}</span>;
  if (typeof value === "string")
    return isLocalFilePath(value) ? (
      <FilePathChip path={value.trim()} />
    ) : (
      <WorkflowRichText text={value} />
    );
  if (typeof value === "boolean")
    return (
      <span className="workflow-value-boolean">
        {value ? t("yes") : t("no")}
      </span>
    );
  if (typeof value === "number")
    return (
      <span className="workflow-value-number">
        {formatNumber(value, { maximumSignificantDigits: 21 })}
      </span>
    );
  if (depth >= 5)
    return (
      <details className="workflow-data-overflow">
        <summary>{t("expandNestedData")}</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  if (Array.isArray(value)) {
    if (!value.length)
      return <span className="workflow-value-empty">{t("noItems")}</span>;
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
          aria-label={t("dataTable")}
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
                      i18n,
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
    return <span className="workflow-value-empty">{t("noFields")}</span>;
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
          <dt>{labelFor(key, properties?.[key], i18n)}</dt>
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
  const { t } = useWorkflowMessages();
  const [raw, setRaw] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="text-control workflow-json-toggle"
        aria-expanded={raw}
        onClick={() => setRaw(!raw)}
      >
        {raw ? t("collapseJson") : t("viewJson")}
      </button>
      {raw ? (
        <pre className="workflow-raw-output">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </>
  );
}
