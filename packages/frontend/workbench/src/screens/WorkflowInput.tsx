import React, { useId, useRef, useState } from "react";
import {
  useWorkflowMessages,
  workflowMessage as message,
} from "../workflow-messages.ts";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
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
import { uploadWorkflowImage } from "../workflowSessions";
import { metadataText, metadataEnumLabel } from "../metadata.ts";

function ImageAssetField({
  id,
  label,
  placeholder,
  value,
  disabled,
  uploading,
  onChange,
  onFile,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  uploading: boolean;
  onChange(value: string): void;
  onFile(file: File): void;
}) {
  const { t } = useWorkflowMessages();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="workflow-path-input">
      <span className="workflow-path-icon" aria-hidden="true">
        <ImagePlus size={17} />
      </span>
      <input
        id={id}
        aria-label={label}
        disabled={disabled || uploading}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
      <input
        ref={fileInput}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled || uploading}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        className="workflow-path-button"
        disabled={disabled || uploading}
        onClick={() => fileInput.current?.click()}
      >
        {uploading ? t("uploading") : t("uploadImage")}
      </button>
    </div>
  );
}

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
  endpoint,
  onUploadBusyChange,
}: {
  schema?: JsonValue;
  text: string;
  onChange(text: string): void;
  disabled: boolean;
  endpoint?: string;
  onUploadBusyChange?(busy: boolean): void;
}) {
  const { t, i18n } = useWorkflowMessages();
  const id = useId();
  const [pickerError, setPickerError] = useState<
    Record<string, string | MessageReference>
  >({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const uploading = useRef(false);
  const latestText = useRef(text);
  latestText.current = text;
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
        const label = metadataText(
          spec,
          "title",
          workflowFieldLabel(key, spec, t),
          i18n,
        );
        const kind = workflowFieldKind(key, spec);
        const description = metadataText(
          spec,
          "description",
          typeof spec.description === "string" ? spec.description : "",
          i18n,
        );
        const placeholder = (native = false) => {
          const fallback =
            kind === "image-asset"
              ? t("uploadImagePlaceholder")
              : workflowFieldPlaceholder(key, kind, spec, native, t);
          return metadataText(
            spec,
            "placeholder",
            ["image", "image-asset", "directory"].includes(kind)
              ? fallback
              : description || fallback,
            i18n,
          );
        };
        const fieldId = `${id}-${index}`;
        const update = (next: JsonValue) => {
          let latest = current;
          try {
            latest = asObject(JSON.parse(latestText.current)) ?? current;
          } catch {
            // The form remains usable while a JSON draft is being edited.
          }
          const nextValue = { ...latest };
          if (next === "" && !required.has(key)) delete nextValue[key];
          else nextValue[key] = next;
          const nextText = JSON.stringify(nextValue, null, 2);
          latestText.current = nextText;
          onChange(nextText);
          setPickerError((errors) => {
            if (!errors[key]) return errors;
            const copy = { ...errors };
            delete copy[key];
            return copy;
          });
        };
        const upload = async (file: File) => {
          if (uploading.current) return;
          if (!endpoint) {
            setPickerError((errors) => ({
              ...errors,
              [key]: message("serviceUnavailable"),
            }));
            return;
          }
          uploading.current = true;
          setUploadingKey(key);
          onUploadBusyChange?.(true);
          try {
            update(await uploadWorkflowImage(endpoint, file));
          } catch (cause) {
            setPickerError((errors) => ({
              ...errors,
              [key]: errorMessage(cause, message("uploadFailed")),
            }));
          } finally {
            uploading.current = false;
            setUploadingKey(null);
            onUploadBusyChange?.(false);
          }
        };
        const choose = async (pathKind: WorkflowPathKind) => {
          try {
            const selected = await chooseWorkflowPath(pathKind);
            if (selected) update(selected);
          } catch (cause) {
            setPickerError((errors) => ({
              ...errors,
              [key]: errorMessage(cause, message("pickerFailed")),
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
                <span className="workflow-required" aria-label={t("required")}>
                  {t("required")}
                </span>
              ) : (
                <span className="workflow-optional">{t("optional")}</span>
              )}
            </label>
            {kind === "multi-select" && multiOptions ? (
              <div
                className="workflow-multi-select"
                role="group"
                aria-labelledby={`${fieldId}-label`}
                aria-describedby={description ? `${fieldId}-hint` : undefined}
              >
                {multiOptions.map((option, optionIndex) => {
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
                      <span>
                        {metadataEnumLabel(
                          asObject(spec.items) ?? spec,
                          optionIndex,
                          workflowOptionLabel(option, t),
                          i18n,
                        )}
                      </span>
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
                {options.map((option, optionIndex) => (
                  <option
                    key={JSON.stringify(option)}
                    value={JSON.stringify(option)}
                  >
                    {metadataEnumLabel(
                      spec,
                      optionIndex,
                      workflowOptionLabel(option, t),
                      i18n,
                    )}
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
                <small>
                  {current[key] === true ? t("enabled") : t("disabled")}
                </small>
              </label>
            ) : kind === "long-text" ? (
              <textarea
                id={fieldId}
                aria-label={label}
                disabled={disabled}
                rows={4}
                placeholder={placeholder()}
                value={String(current[key] ?? "")}
                onChange={(event) => update(event.target.value)}
              />
            ) : kind === "image-asset" ? (
              <>
                <ImageAssetField
                  id={fieldId}
                  label={label}
                  placeholder={placeholder()}
                  value={String(current[key] ?? "")}
                  disabled={disabled}
                  uploading={uploadingKey === key}
                  onChange={update}
                  onFile={(file) => void upload(file)}
                />
                {pickerError[key] ? (
                  <small className="workflow-field-error" role="alert">
                    {messageText(pickerError[key], i18n)}
                  </small>
                ) : (
                  <small className="workflow-field-hint">
                    {t("imageAssetHint")}
                  </small>
                )}
              </>
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
                    placeholder={placeholder(desktop)}
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
                          ? t("chooseField", { label })
                          : t("pickerUnavailable")
                      }
                    >
                      {t("choose")}
                    </button>
                  ) : null}
                </div>
                {pickerError[key] ? (
                  <small className="workflow-field-error" role="alert">
                    {messageText(pickerError[key], i18n)}
                  </small>
                ) : !desktop ? (
                  <small className="workflow-field-hint">
                    {t(kind === "image" ? "webImagePath" : "webDirectoryPath")}
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
                placeholder={placeholder()}
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
            {kind === "multi-select" && description ? (
              <small id={`${fieldId}-hint`} className="workflow-field-hint">
                {description}
              </small>
            ) : null}
          </div>
        );
      })}
    </div>
  ) : (
    <label className="workflow-input-field">
      <span>{t("inputJson")}</span>
      <textarea
        aria-label={t("inputJsonLabel")}
        disabled={disabled}
        rows={4}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </label>
  );
}
