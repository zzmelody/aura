import React from "react";
import type { JsonValue } from "@aura/protocol/types";

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
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const properties = asObject(asObject(schema)?.properties);
  const current = asObject(value);
  const fields = Object.entries(properties ?? {});
  const simple =
    current &&
    fields.length > 0 &&
    fields.every(([, field]) =>
      ["string", "number", "integer", "boolean"].includes(
        String(asObject(field)?.type),
      ),
    );
  return simple ? (
    <div className="workflow-input-fields">
      {fields.map(([key, field]) => {
        const spec = asObject(field) ?? {};
        const label = typeof spec.title === "string" ? spec.title : key;
        const update = (next: JsonValue) =>
          onChange(JSON.stringify({ ...current, [key]: next }, null, 2));
        return (
          <label key={key} className="workflow-input-field">
            <span>{label}</span>
            {Array.isArray(spec.enum) ? (
              <select
                aria-label={label}
                disabled={disabled}
                value={JSON.stringify(current[key] ?? spec.enum[0])}
                onChange={(event) => update(JSON.parse(event.target.value))}
              >
                {spec.enum.map((option) => (
                  <option
                    key={JSON.stringify(option)}
                    value={JSON.stringify(option)}
                  >
                    {String(option)}
                  </option>
                ))}
              </select>
            ) : spec.type === "boolean" ? (
              <input
                type="checkbox"
                disabled={disabled}
                checked={current[key] === true}
                onChange={(event) => update(event.target.checked)}
              />
            ) : spec.type === "string" ? (
              <textarea
                aria-label={label}
                disabled={disabled}
                rows={fields.length === 1 ? 3 : 2}
                placeholder={
                  typeof spec.description === "string"
                    ? spec.description
                    : "输入本次任务…"
                }
                value={String(current[key] ?? "")}
                onChange={(event) => update(event.target.value)}
              />
            ) : (
              <input
                aria-label={label}
                disabled={disabled}
                type="number"
                step={spec.type === "integer" ? 1 : "any"}
                value={String(current[key] ?? "")}
                onChange={(event) =>
                  update(
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
              />
            )}
          </label>
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
