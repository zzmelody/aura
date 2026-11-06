import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { NativeFailureCode } from "@aura/protocol/native-ui";

/**
 * Resolves a deliverable for "show in folder". Absolute paths can refer to any
 * directory; relative paths resolve against the project. Only existing regular
 * files qualify. Revealing selects the file without opening or executing it.
 *
 * @returns the absolute file path, or a safe error code.
 */
export async function revealTarget(
  root: unknown,
  path: unknown,
): Promise<{ path: string } | { error: NativeFailureCode }> {
  if (typeof path !== "string" || !path.trim())
    return { error: "filePathInvalid" };
  let target: string;
  if (isAbsolute(path)) {
    target = resolve(path);
  } else {
    if (typeof root !== "string" || !isAbsolute(root))
      return { error: "fileRootRequired" };
    target = resolve(root, path);
  }
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) return { error: "fileNotFound" };
  return { path: target };
}
