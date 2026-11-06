import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
// Type-only: activates the workspace registry's `Context` augmentation.
import type {} from "@deepseek-ai/dsh-workspace";
import { SessionId } from "@deepseek-ai/dsh-session";
import { CodedFlowError } from "@aura/protocol/errors";
import type { CodingProjectInfo } from "@aura/protocol/types";

/**
 * Coding projects are directories the user works in. DSH's workspace registry
 * owns the durable records — canonical realpath uniqueness, ordering, and
 * session accounting — so this library only validates input and projects the
 * registry's shape into the DTO the client consumes.
 *
 * A conversation joins a project through its session header cwd, which the
 * registry indexes and validates itself; nothing here maintains that
 * membership by hand. Titles come from Aura's own index, because a DSH session
 * header carries none.
 */
export class CodingProjects {
  private readonly ctx: Context;
  private defaultId?: string;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Ordered projects, newest first, as the registry stores them. */
  list(): CodingProjectInfo[] {
    return this.ctx.workspaceRegistry.list().map((entry) => ({
      ...project(entry),
      ...(entry.id === this.defaultId ? { isDefault: true as const } : {}),
    }));
  }

  /** The runtime creates this directory; clients never supply its path. */
  async defaultProject(): Promise<CodingProjectInfo> {
    if (!this.defaultId) {
      const directory = process.env.AURA_DEFAULT_WORKSPACE;
      if (!directory)
        throw new CodedFlowError("默认工作目录未配置。", 503, {
          code: "workspace_default_unconfigured",
        });
      const entry = await this.create(directory, "默认工作空间");
      this.defaultId = entry.id;
    }
    return {
      ...this.list().find((entry) => entry.id === this.defaultId)!,
      isDefault: true,
    };
  }

  /**
   * Registers a directory as a project. The registry canonicalizes through
   * `fs.realpath` and returns the existing record for a repeated path, so
   * adding the same directory twice is not an error.
   */
  async create(directory: string, title?: string): Promise<CodingProjectInfo> {
    const path = await this.requireDirectory(directory);
    const name = title?.trim().slice(0, 100);
    return project(await this.ctx.workspaceRegistry.create(path, name));
  }

  async rename(id: string, title: string): Promise<CodingProjectInfo> {
    const name = title.trim().slice(0, 100);
    if (!name)
      throw new CodedFlowError("项目名称不能为空。", 400, {
        code: "workspace_title_empty",
      });
    const workspace = this.require(id);
    await workspace.setTitle(name);
    return project(workspace);
  }

  /**
   * Points a project at another directory. The registry never rewrites a
   * record's canonical path, so this registers the new directory under the
   * same title and drops the old registration. Conversations stay bound to the
   * directory they ran in: their logs are untouched and reappear if the old
   * directory is added back.
   */
  async relocate(id: string, directory: string): Promise<CodingProjectInfo> {
    if (id === this.defaultId)
      throw new CodedFlowError("默认工作空间不能更换目录。", 400, {
        code: "workspace_default_relocate_forbidden",
      });
    const current = this.require(id);
    const path = await this.requireDirectory(directory);
    const taken = new Set(
      this.ctx.workspaceRegistry.list().map((item) => item.id as string),
    );
    const next = await this.ctx.workspaceRegistry.create(path, current.title);
    if (next.id === current.id) return project(current);
    if (taken.has(next.id))
      throw new CodedFlowError("该目录已是另一个工作空间。", 400, {
        code: "workspace_directory_taken",
      });
    await this.ctx.workspaceRegistry.delete(current.id);
    return project(next);
  }

  /**
   * Removes the registration only. The directory, its files and every session
   * log are left untouched, matching the registry's contract.
   */
  async remove(id: string): Promise<boolean> {
    if (id === this.defaultId)
      throw new CodedFlowError("默认工作空间不能移除。", 400, {
        code: "workspace_default_remove_forbidden",
      });
    return this.ctx.workspaceRegistry.delete(workspaceId(id));
  }

  /**
   * Records a conversation under its project. The registry validates that the
   * session's header cwd really resolves to the project directory, so an
   * attach for the wrong project rejects rather than mis-grouping.
   */
  async attach(projectId: string, sessionId: string): Promise<void> {
    const workspace = this.require(projectId);
    await workspace.attachSession(SessionId(sessionId));
  }

  /** Whether the directory still exists, so the UI can flag a moved project. */
  async status(id: string): Promise<"ok" | "missing-dir"> {
    return this.require(id).status();
  }

  /** The canonical directory for a project, for binding a coding session. */
  directory(id: string): string {
    return this.require(id).path;
  }

  private require(id: string) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId(id));
    if (!workspace)
      throw new CodedFlowError("项目不存在或已移除。", 404, {
        code: "workspace_missing",
      });
    return workspace;
  }

  /**
   * A coding session needs a real absolute directory: a relative spelling or a
   * missing path would leave the sandbox without a workspace root.
   */
  private async requireDirectory(directory: string): Promise<string> {
    const value = directory?.trim();
    if (!value)
      throw new CodedFlowError("请提供项目目录。", 400, {
        code: "workspace_directory_required",
      });
    if (!isAbsolute(value))
      throw new CodedFlowError("项目目录必须是绝对路径。", 400, {
        code: "workspace_directory_absolute",
      });
    const info = await stat(value).catch(() => undefined);
    if (!info?.isDirectory())
      throw new CodedFlowError("该路径不存在或不是目录。", 400, {
        code: "workspace_directory_missing",
      });
    return value;
  }
}

function project(workspace: {
  id: string;
  path: string;
  title: string;
}): CodingProjectInfo {
  return {
    id: workspace.id,
    directory: workspace.path,
    title: workspace.title,
  };
}

function workspaceId(id: string) {
  return id as Parameters<Context["workspaceRegistry"]["get"]>[0];
}
