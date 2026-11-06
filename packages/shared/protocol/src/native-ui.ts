/** Safe, parameter-free failures from the desktop UI bridge. Never carries paths or raw exceptions. */
export const nativeFailureCodes = [
  "pickerKindUnsupported",
  "pickerFailed",
  "previewInvalid",
  "previewLocalOnly",
  "previewFailed",
  "browserOwnerRequired",
  "browserWorkspaceRequired",
  "browserTabLimit",
  "browserAddressBlocked",
  "browserOperationFailed",
  "fileMainWindowOnly",
  "fileRevealFailed",
  "filePathInvalid",
  "fileRootRequired",
  "fileNotFound",
] as const;
export type NativeFailureCode = (typeof nativeFailureCodes)[number];

export interface NativeFailure {
  type: "aura.native.failure";
  code: NativeFailureCode;
}

export function isNativeFailure(value: unknown): value is NativeFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "aura.native.failure" &&
    "code" in value &&
    nativeFailureCodes.some((code) => code === value.code)
  );
}

/** Legacy hosts can still resolve successful values directly. Failures are explicit bridge DTOs. */
export type NativeHost<Api> = {
  [Key in keyof Api]: Api[Key] extends (
    ...args: infer Args
  ) => Promise<infer Value>
    ? (...args: Args) => Promise<Value | NativeFailure>
    : Api[Key];
};
