import React, { useId, useState } from "react";
import { FolderOpen, ImagePlus } from "lucide-react";
import type { JsonValue } from "@aura/protocol/types";
import {
  chooseWorkflowPath,
  workflowFilePickerAvailable,
  type WorkflowPathKind,
} from "../file-picker";
import {
  workflowCanRenderFields,
  workflowEnumArrayOptions,
  workflowFieldKind,
  workflowFieldLabel,
  workflowFieldPlaceholder,
  workflowOptionLabel,
} from "../workflowInputModel";
import { platform } from "../platform";

export const asObject = (value: JsonValue | undefined) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

export function schemaInitialValue(value: JsonValue | undefined): JsonValue {
  const schema = asObject(value);
  if (!schema) return {};
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? "";
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(asObject(schema.properties) ?? {})
        .filter(
          ([key, field]) =>
            (Array.isArray(schema.required) && schema.required.includes(key)) ||
            asObject(field)?.default !== undefined,
        )
        .map(([key, field]) => [key, schemaInitialValue(field)]),
    );
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  return "";
}

export function WorkflowInput({
  schema,
  text,
  onChange,
  disabled,
}: {
  schema?: JsonValue;
  text: string;
  onChange(text: string): void;
  disabled: boolean;
}) {
  const id = useId();
  const [pickerError, setPickerError] = useState<Record<string, string>>({});
  const desktop = platform() === "desktop";
  const pickerAvailable = workflowFilePickerAvailable();
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const properties = asObject(asObject(schema)?.properties);
  const current = asObject(value);
  const fields = Object.entries(properties ?? {});
  const required = new Set(
    Array.isArray(asObject(schema)?.required)
      ? (asObject(schema)?.required as JsonValue[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const simple =
    current && fields.length > 0 && workflowCanRenderFields(properties ?? {});
  return simple ? (
    <div className="workflow-input-fields">
      {fields.map(([key, field], index) => {
        const spec = asObject(field) ?? {};
        const options = Array.isArray(spec.enum) ? spec.enum : [];
        const multiOptions = workflowEnumArrayOptions(spec);
        const selected = Array.isArray(current[key]) ? current[key] : [];
        const label = workflowFieldLabel(key, spec);
        const kind = workflowFieldKind(key, spec);
        const fieldId = `${id}-${index}`;
        const update = (next: JsonValue) => {
          const nextValue = { ...current };
          if (next === "" && !required.has(key)) delete nextValue[key];
          else nextValue[key] = next;
          onChange(JSON.stringify(nextValue, null, 2));
          setPickerError((errors) => {
            if (!errors[key]) return errors;
            const copy = { ...errors };
            delete copy[key];
            return copy;
          });
        };
        const choose = async (pathKind: WorkflowPathKind) => {
          try {
            const selected = await chooseWorkflowPath(pathKind);
            if (selected) update(selected);
          } catch (cause) {
            setPickerError((errors) => ({
              ...errors,
              [key]:
                cause instanceof Error ? cause.message : "无法打开路径选择器。",
            }));
          }
        };
        return (
          <div
            key={key}
            className={`workflow-input-field workflow-input-${kind}`}
          >
            <label
              className="workflow-field-label"
              id={`${fieldId}-label`}
              htmlFor={kind === "multi-select" ? undefined : fieldId}
            >
              <span>{label}</span>
              {required.has(key) ? (
                <span className="workflow-required" aria-label="必填">
                  必填
                </span>
              ) : (
                <span className="workflow-optional">可选</span>
              )}
            </label>
            {kind === "multi-select" && multiOptions ? (
              <div
                className="workflow-multi-select"
                role="group"
                aria-labelledby={`${fieldId}-label`}
                aria-describedby={
                  typeof spec.description === "string"
                    ? `${fieldId}-hint`
                    : undefined
                }
              >
                {multiOptions.map((option) => {
                  const checked = selected.includes(option);
                  const min =
                    typeof spec.minItems === "number" ? spec.minItems : 0;
                  const max =
                    typeof spec.maxItems === "number"
                      ? spec.maxItems
                      : multiOptions.length;
                  return (
                    <label
                      key={JSON.stringify(option)}
                      className={`workflow-option${checked ? " selected" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          disabled ||
                          (checked
                            ? selected.length <= min
                            : selected.length >= max)
                        }
                        onChange={() =>
                          update(
                            checked
                              ? selected.filter((item) => item !== option)
                              : [...selected, option],
                          )
                        }
                      />
                      <span>{workflowOptionLabel(option)}</span>
                    </label>
                  );
                })}
              </div>
            ) : kind === "select" ? (
              <select
                id={fieldId}
                aria-label={label}
                disabled={disabled}
                value={JSON.stringify(current[key] ?? options[0])}
                onChange={(event) => update(JSON.parse(event.target.value))}
              >
                {options.map((option) => (
                  <option
                    key={JSON.stringify(option)}
                    value={JSON.stringify(option)}
                  >
                    {workflowOptionLabel(option)}
                  </option>
                ))}
              </select>
            ) : kind === "boolean" ? (
              <label className="workflow-switch" htmlFor={fieldId}>
                <input
                  id={fieldId}
                  type="checkbox"
                  disabled={disabled}
                  checked={current[key] === true}
                  onChange={(event) => update(event.target.checked)}
                />
                <span aria-hidden="true" />
                <small>{current[key] === true ? "已开启" : "未开启"}</small>
              </label>
            ) : kind === "long-text" ? (
              <textarea
                id={fieldId}
                aria-label={label}
                disabled={disabled}
                rows={4}
                placeholder={workflowFieldPlaceholder(key, kind, spec)}
                value={String(current[key] ?? "")}
                onChange={(event) => update(event.target.value)}
              />
            ) : kind === "image" || kind === "directory" ? (
              <>
                <div className="workflow-path-input">
                  <span className="workflow-path-icon" aria-hidden="true">
                    {kind === "image" ? (
                      <ImagePlus size={17} />
                    ) : (
                      <FolderOpen size={17} />
                    )}
                  </span>
                  <input
                    id={fieldId}
                    aria-label={label}
                    disabled={disabled}
                    type="text"
                    value={String(current[key] ?? "")}
                    placeholder={workflowFieldPlaceholder(
                      key,
                      kind,
                      spec,
                      desktop,
                    )}
                    onChange={(event) => update(event.target.value)}
                    autoComplete="off"
                  />
                  {desktop ? (
                    <button
                      type="button"
                      className="workflow-path-button"
                      disabled={disabled}
                      onClick={() => void choose(kind)}
                      title={
                        pickerAvailable
                          ? `选择${label}`
                          : "路径选择服务未连接；点击查看处理方法"
                      }
                    >
                      选择
                    </button>
                  ) : null}
                </div>
                {pickerError[key] ? (
                  <small className="workflow-field-error" role="alert">
                    {pickerError[key]}
                  </small>
                ) : !desktop ? (
                  <small className="workflow-field-hint">
                    Web 版可粘贴 Aura 服务端可访问的
                    {kind === "image" ? "图片" : "目录"}
                    路径；选择本机路径请使用 Aura Desktop。
                  </small>
                ) : null}
              </>
            ) : (
              <input
                id={fieldId}
                aria-label={label}
                disabled={disabled}
                type={kind === "number" ? "number" : "text"}
                step={
                  kind === "number"
                    ? spec.type === "integer"
                      ? 1
                      : "any"
                    : undefined
                }
                min={
                  kind === "number" && typeof spec.minimum === "number"
                    ? spec.minimum
                    : undefined
                }
                max={
                  kind === "number" && typeof spec.maximum === "number"
                    ? spec.maximum
                    : undefined
                }
                placeholder={workflowFieldPlaceholder(key, kind, spec)}
                value={String(current[key] ?? "")}
                onChange={(event) =>
                  update(
                    kind === "number" && event.target.value !== ""
                      ? Number(event.target.value)
                      : event.target.value,
                  )
                }
                autoComplete="off"
              />
            )}
            {kind === "multi-select" && typeof spec.description === "string" ? (
              <small id={`${fieldId}-hint`} className="workflow-field-hint">
                {spec.description}
              </small>
            ) : null}
          </div>
        );
      })}
    </div>
  ) : (
    <label className="workflow-input-field">
      <span>运行输入（JSON）</span>
      <textarea
        aria-label="运行输入 JSON"
        disabled={disabled}
        rows={4}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </label>
  );
}
