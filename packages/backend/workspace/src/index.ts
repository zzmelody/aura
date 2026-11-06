import type { Context } from "@deepseek-ai/cordis";
import { CodedFlowError } from "@aura/protocol/errors";
import { z } from "zod";
import { CodingProjects } from "./projects.ts";
import { WorkspaceTerminals } from "./terminals.ts";

export function createWorkspaceService(ctx: Context) {
  const projects = new CodingProjects(ctx);
  const terminals = new WorkspaceTerminals(ctx.subprocess, (id) =>
    projects.directory(id),
  );
  ctx.effect(
    () => () => terminals.close(),
    "aura-workspace-terminals.lifecycle",
  );
  return {
    projects: {
      list: () => projects.list(),
      defaultProject: () => projects.defaultProject(),
      directory: (id: string) => projects.directory(id),
      attach: (id: string, sessionId: string) => projects.attach(id, sessionId),
    },
    request,
    close: () => terminals.close(),
  };

  async function request(method: string, params: Record<string, unknown>) {
    let data: unknown;
    switch (method) {
      case "coding/terminals/list":
      case "coding/terminals/open":
      case "coding/terminals/read":
      case "coding/terminals/write":
      case "coding/terminals/resize":
      case "coding/terminals/close": {
        const input = z
          .object({
            projectId: z.string().min(1).max(200).optional(),
            terminalId: z.string().startsWith("terminal-").max(100).optional(),
            cols: z.number().int().min(2).max(500).default(80),
            rows: z.number().int().min(1).max(200).default(24),
            cursor: z
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .default(0),
            data: z.string().max(16_384).optional(),
            force: z.boolean().default(false),
          })
          .safeParse(params);
        if (!input.success)
          throw new CodedFlowError("无效的终端请求。", 400, {
            code: "terminal_request_invalid",
          });
        const request = input.data;
        if (
          method === "coding/terminals/list" ||
          method === "coding/terminals/open"
        ) {
          if (!request.projectId)
            throw new CodedFlowError("请选择工作空间。", 400, {
              code: "workspace_required",
            });
          data =
            method === "coding/terminals/list"
              ? terminals.list(request.projectId)
              : await terminals.open(
                  request.projectId,
                  request.cols,
                  request.rows,
                );
        } else {
          if (!request.terminalId)
            throw new CodedFlowError("请选择终端。", 400, {
              code: "terminal_required",
            });
          if (method === "coding/terminals/read")
            data = await terminals.read(request.terminalId, request.cursor);
          if (method === "coding/terminals/write") {
            if (request.data === undefined)
              throw new CodedFlowError("缺少终端输入。", 400, {
                code: "terminal_input_missing",
              });
            await terminals.write(request.terminalId, request.data);
            data = { updated: true };
          }
          if (method === "coding/terminals/resize") {
            await terminals.resize(
              request.terminalId,
              request.cols,
              request.rows,
            );
            data = { updated: true };
          }
          if (method === "coding/terminals/close") {
            await terminals.closeTerminal(request.terminalId, request.force);
            data = { closed: true };
          }
        }
        break;
      }
      case "coding/projects":
        await projects.defaultProject();
        data = projects.list();
        break;
      case "coding/projects/create": {
        const input = z
          .object({
            directory: z.string().trim().min(1).max(4096),
            title: z.string().trim().max(100).optional(),
          })
          .safeParse(params);
        if (!input.success)
          throw new CodedFlowError("无效的项目目录。", 400, {
            code: "workspace_directory_invalid",
          });
        data = await projects.create(input.data.directory, input.data.title);
        break;
      }
      case "coding/projects/rename": {
        const input = z
          .object({
            id: z.string().trim().min(1).max(200),
            title: z.string().trim().min(1).max(100),
          })
          .safeParse(params);
        if (!input.success)
          throw new CodedFlowError("无效的项目名称。", 400, {
            code: "workspace_title_invalid",
          });
        data = await projects.rename(input.data.id, input.data.title);
        break;
      }
      case "coding/projects/relocate": {
        const input = z
          .object({
            id: z.string().trim().min(1).max(200),
            directory: z.string().trim().min(1).max(4096),
          })
          .safeParse(params);
        if (!input.success)
          throw new CodedFlowError("无效的项目目录。", 400, {
            code: "workspace_directory_invalid",
          });
        const relocated = await projects.relocate(
          input.data.id,
          input.data.directory,
        );
        data = relocated;
        if (relocated.id !== input.data.id)
          await terminals.closeProject(input.data.id);
        break;
      }
      case "coding/projects/remove": {
        if (typeof params.id !== "string")
          throw new CodedFlowError("无效的项目。", 400, {
            code: "workspace_invalid",
          });
        data = await projects.remove(params.id);
        if (data) await terminals.closeProject(params.id);
        break;
      }
      case "coding/projects/status": {
        if (typeof params.id !== "string")
          throw new CodedFlowError("无效的项目。", 400, {
            code: "workspace_invalid",
          });
        data = await projects.status(params.id);
        break;
      }
      default:
        return undefined;
    }
    return { data };
  }
}
