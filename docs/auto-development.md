# 远程需求自动开发

此流程让仓库所有者在 GitHub 上提交需求，由本机 Windows runner 调用 Codex CLI 开发，随后由 GitHub 托管 runner 验证代码并以 GitHub App 身份推送新分支、创建 PR。PR 不自动合并。实现位于 `.github/workflows/auto-develop.yml` 和 `scripts/ci/auto-*.ts`。

## 触发方式

- 由 `zzmelody` 向 `main` 推送 `docs/requests/**/*.md`。每次推送最多处理五个新增或修改的需求文件；删除文件不会产生开发任务。建议每次推送只放一个独立需求。

只有 `zzmelody/aura` 仓库由 `zzmelody` 本人推送到 `main` 才会触发本机开发；新建或编辑 Issue 不会触发。推送的机器人分支不会反过来触发新开发任务。开发任务一次只运行一个，其余任务排队。运行结果在 Actions 页查看；成功后会出现 `codex/auto-<run-id>-<attempt>` 分支及 PR。验证失败时仍创建草稿 PR，并在正文标明失败；Codex 没有产生改动或改动触及自动化、凭据、需求文档等受保护路径时直接失败，不推送代码。

## 一次性配置

1. 先按 [本机 runner 配置](ci-runner.md)注册 `zzmelody-aura-win`。保持 Windows 开机、联网、不要休眠，并让 `AuraCI` 交互会话中的 runner 持续在线。现有 `Enter-CiMode.ps1` 是手动上线入口；如果 runner 离线超过 24 小时，排队的 GitHub 作业会失败。远程无人值守期间不要退出 CI 模式，也不要在日常账号启动携带凭据的本机服务。
2. 在 `AuraCI` 账号自己的会话中安装 Codex CLI，并完成该账号的 `codex login`。运行 `codex login status` 确认认证有效；再用一份可丢弃的测试仓库验证 `codex -a never exec --sandbox workspace-write -c 'windows.sandbox="elevated"'` 可以非交互执行。不要复制日常账号的 Codex 凭据到 `AuraCI`。此工作流要求原生 Windows `elevated` 沙箱，未配置成功时应让作业失败。
3. 注册一个仅安装到 `zzmelody/aura` 的 GitHub App。授予仓库 `Contents: Read and write` 与 `Pull requests: Read and write`；此方案由 Actions 事件触发，不需要开启 App webhook。把 App 的 **Client ID** 存为仓库变量 `AUTO_DEV_APP_CLIENT_ID`，把私钥存为仓库 Secret `AUTO_DEV_APP_PRIVATE_KEY`。App 私钥只在 GitHub 托管的发布 job 使用，不发送到本机 runner。
4. 提交此工作流和脚本后，向 `main` 推送一份小型测试需求文档，确认本地开发、托管验证和 PR 创建三段都完成。测试完成前不要依赖它处理紧急需求。

## 执行边界

本地开发 job 的 `GITHUB_TOKEN` 只有仓库读取权限，checkout 不保留 GitHub 凭据。Codex 在 `AuraCI` 账号和 Windows `workspace-write` 沙箱中工作；它不能直接推送。开发完成后，脚本只上传补丁和简短总结。验证 job 在一次性 GitHub 托管机器上应用补丁并运行 `pnpm install --frozen-lockfile`、`pnpm run check`。发布 job 不执行生成代码，只用 GitHub App 短期令牌提交补丁和创建 PR。

需求文档会交给 Codex 作为任务输入；不要在其中放密钥。任何能修改仓库默认分支的人都能触发本机开发，因此保留 [CI runner 文档](ci-runner.md)所述的私有、单写入者限制。依赖安装和运行检查会执行仓库代码；本机开发账号应只保存完成这项工作必需的认证。

如果任务要求改变 `.github/`、`scripts/ci/`、`AGENTS.md`、`.aura/`、`.env*` 或需求文档，请改为正常的人工开发任务。自动任务不会发布这些路径的变更。
