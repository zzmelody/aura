# 需求驱动的本机自动开发

将一份或多份 docs/requirements/*.md 推送到 main 后，Develop requirements into dev 工作流在 AuraCI 的交互式 Windows 会话中调用 Codex CLI。每份需求使用独立的本地 Git 分支开发；成功的分支合入本地 dev 候选分支，最后由独立的 GitHub 托管发布 job 推送远端 dev。不创建 PR，也不自动合入 main。

需求格式见 docs/requirements/README.txt。工作流只接收 zzmelody 对私有 zzmelody/aura 的 main 推送，不响应 Issue 或外部 PR。一个推送最多处理 20 份需求，按文件名顺序逐个执行。仓库级队列保留后续推送，避免较新的任务取消等待中的任务。成功的需求在 dev 标记“已完成”；main 上的状态在你将 dev 合回 main 后更新。已完成且内容未变化的需求会被跳过。

## 执行与失败处理

- 本机开发 job 的 GITHUB_TOKEN 只有读取权限，checkout 不保存 GitHub 凭据。可信脚本先复制到 runner 临时目录，再运行 Codex；Codex 使用非交互的 workspace-write 沙箱和 Windows `unelevated` 模式，不会等待提问或审批。图形任务关闭 Codex 的私有桌面，以便在 AuraCI 的真实交互会话中截图。
- 可信入口按 UTF-8 读取需求提示词并以 UTF-8 向 Codex 传递标准输入和控制台输出，保证中文需求与 Actions 日志不被 Windows PowerShell 的默认代码页改写。
- Codex 必须运行相关测试并报告命令和结果。它不能修改工作流、CI 脚本、AGENTS.md、凭据文件或其他需求文档。可信脚本在测试和视觉复核通过后，只改当前需求文档的状态；若没有实现改动、测试失败或触及保护路径，该需求不会进入 dev。
- visual: true 的需求必须产出真实程序截图，保存到 ci-evidence/<需求ID>/。脚本检查 PNG 文件非空且尺寸合理，再把图片交给一次只读 Codex 视觉复核。截图作为短期 Actions artifact 保存，不进入 Git。
- 本地 dev 候选分支先合入触发需求的 main 提交。遇到普通代码冲突时，Codex 解决并复测；若冲突触及 CI 控制文件或需求状态，任务失败。
- 发布 job 检查需求在 main 上的内容未被改写、受保护文件未被 Codex 改写、候选提交基于预期的 dev，再做非强制推送。只有 GitHub 托管的发布 job 使用短期 `GITHUB_TOKEN` 的仓库内容写权限。若远端 dev 在开发期间前进，本机 job 会再合并一次、由 Codex 复测，然后尝试第二次发布。第二次仍不满足条件则失败，远端 dev 保持不变。

同一仓库的工作流串行；Aura 与 Veya 可以同时运行。图形任务使用主机 GPU 锁，不得把无界面运行当作真实渲染验收。发生部分失败时，成功需求仍可进入 dev，Actions 总结果会标记失败并列出失败需求。

## 一次性配置

1. 保持 zzmelody-aura-win runner 在 AuraCI 交互会话中在线，并验证图形任务在实际使用的桌面状态下可以截图。不要以 Windows 服务运行需要真实渲染的任务。
2. 在 AuraCI 账号下安装 Codex CLI、完成该账号自己的 codex login，并验证非交互 workspace-write 模式可用。不要复制日常账号的凭据。
3. 确认仓库 Actions 设置允许工作流申请 `contents: write`，且 `dev` 分支允许工作流的 `GITHUB_TOKEN` 正常推送。写权限只在 GitHub 托管的发布 job 生效，不进入本机 Codex job；保持 main 由你控制。
4. 用一份小型需求分别验证解析、Codex 开发、测试、截图、dev 推送、失败不发布、需求变更中止和冲突复测。首次通过前不要依赖该流程处理紧急任务。

Aura 的常规 local-ci.yml 检查不再因每次 main 推送自动运行；开发需求时运行相关测试。仓库结构调整仍须遵守 AGENTS.md 的完整检查要求。
