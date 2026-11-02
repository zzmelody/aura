import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolves a deliverable for "show in folder". Absolute paths can refer to any
 * directory; relative paths resolve against the project. Only existing regular
 * files qualify. Revealing selects the file without opening or executing it.
 *
 * @returns the absolute file path, or an error message for the user.
 */
export async function revealTarget(
  root: unknown,
  path: unknown,
): Promise<{ path: string } | { error: string }> {
  if (typeof path !== "string" || !path.trim())
    return { error: "文件路径无效。" };
  let target: string;
  if (isAbsolute(path)) {
    target = resolve(path);
  } else {
    if (typeof root !== "string" || !isAbsolute(root))
      return { error: "项目目录无效。" };
    target = resolve(root, path);
  }
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) return { error: "文件不存在或已被移动。" };
  return { path: target };
}
