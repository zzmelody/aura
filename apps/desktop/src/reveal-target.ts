import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves a deliverable for "show in folder". A coding agent declares files
 * relative to its project, so the path is resolved against the project root
 * and must stay inside it: the renderer cannot point the file manager at an
 * arbitrary location. Only existing regular files qualify.
 *
 * @returns the absolute file path, or an error message for the user.
 */
export async function revealTarget(
  root: unknown,
  path: unknown,
): Promise<{ path: string } | { error: string }> {
  if (typeof root !== "string" || !isAbsolute(root))
    return { error: "项目目录无效。" };
  if (typeof path !== "string" || !path.trim())
    return { error: "文件路径无效。" };
  const target = resolve(root, path);
  const inside = relative(resolve(root), target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    return { error: "只能定位项目目录内的文件。" };
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) return { error: "文件不存在或已被移动。" };
  return { path: target };
}
