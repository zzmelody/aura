# Aura 前端、后端与共享包拆分

Aura 使用 pnpm workspace 管理 `packages/frontend/*`、`packages/backend/*` 与 `packages/shared/*`。移动应用和 UI 组件属于 frontend；HTTP runtime 与 DSH 授权适配属于 backend；协议、客户端数据和离线演示属于 shared。每个包声明 `aura.layer` 与 `aura.kind`，Aura 包之间使用 `workspace:*` 和显式导出。

工作区检查拒绝逆向分层依赖、跨包相对导入、私有子路径、未声明依赖、应用被其他包依赖和依赖环。shared 不依赖 React、Expo、Node 服务或凭据代码；frontend 不依赖 backend；所有模型 provider 与交互式授权必须经过 DSH。

迁移不改变 `aura.workspace.v1` 存储键、记录格式或离线演示行为。仓库保留一份 `pnpm-lock.yaml`，旧的 `apps`、`services`、`shared` 与扁平 `packages/*` 空目录已删除。官方 DSH 保持已发布依赖，不复制仓库或修改安装源码。
