# @aura/workspace

`createWorkspaceService` 组合 DSH 工作区注册表和工作区终端服务。项目注册、目录校验、默认工作区、会话目录绑定校验和终端生命周期由本包处理。项目删除或重定位时关闭原项目的终端。Agent 通过宿主提供的端口解析工作目录并验证 DSH 会话绑定。

`coding/terminals/*` RPC 管理用户的工作区终端。`src/terminals.ts` 仅使用已发布的 `ctx.subprocess.terminalEnvironment/resolveExecutable/spawnTerminal`，不复制 DSH、不创建 Agent，也不持有模型凭据。PTY 以已注册工作区的目录启动；客户端不能传入任意 cwd、可执行文件或环境变量。DSH 提供父环境凭据过滤和完整进程会话的终止。终端有独立身份、1 MiB 有界输出与分页游标，输入、尺寸、活动检查和关闭均指向该身份。重放会过滤已经回答过的终端查询，防止重连时将旧设备响应混入当前输入。关闭工作区终端或 runtime 时等待 DSH 完整清理进程后才移除终端。未指定 `force` 的 POSIX 终端在重新确认空闲并阻止新输入后，先通过公开 `signalForeground("SIGHUP")` 挂断 shell，避免交互式 shell 忽略 TERM 时固定等待 3 秒；挂断失败仍执行 DSH 的完整清理。启动中、忙碌、活动未知及 Windows 终端保留原有 3 秒退出宽限期，不提前升级终止。关闭仍忙碌或活动未知的终端先返回 409，只有用户确认后才强制关闭。终端仅在当前服务进程中存在，重启不恢复命令。

## 验证

工作区目录、名称、默认工作区约束和终端请求／关闭确认的安全错误使用 `CodedFlowError` 附加稳定显示码，保留原 message/status。错误详情不包含目录或终端输出；目录注册、终端身份、强制关闭确认和进程清理规则保持原样。`coding-workspaces-dsh.test.ts` 在 runtime 包中验证真实 DSH RPC 的错误码往返，终端测试验证拒绝关闭仍不会结束进程。

从仓库根运行 `pnpm --filter @aura/workspace run typecheck` 和 `pnpm --filter @aura/workspace run test`。项目变更与 HTTP 集成测试位于 `@aura/runtime`。
