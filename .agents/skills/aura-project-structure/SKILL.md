---
name: aura-project-structure
description: Aura 仓库的目录规范、应用与包放置、三层依赖方向和各 package 的模块职责。在新增包或应用、移动文件、决定某段逻辑放哪个包、改动 workspace 依赖或跨包导入、以及判断业务代码属于宿主还是插件时加载。
---

# Aura 项目结构规范

本仓库是 Aura 宿主。pnpm workspace 只收 `apps/*` 与 `packages/{frontend,backend,shared}/*`（见 `pnpm-workspace.yaml`）；根 `plugins/*` 随产品发布但不属于 workspace。个人业务插件在独立仓库 aura-studio。

本规范自包含，禁止依赖项目外的规范或指引，不链接、调用或要求加载其他 skill。支持文件只放在本 skill 目录内，内部文件可以互相引用。项目源码、工具配置及记录是事实输入，不是外置规则。

各包文件级职责见本 skill 内的[模块职责](references/module-boundaries.md)。

## 三层与依赖方向

| 位置                  | 放置内容                                         | 允许依赖                |
| --------------------- | ------------------------------------------------ | ----------------------- |
| `apps/*`              | 可运行、可发布的入口与平台生命周期               | 按平台使用下列 library  |
| `packages/frontend/*` | 可复用 React Web 界面、交互状态、导航、宿主适配  | frontend、shared        |
| `packages/backend/*`  | HTTP 服务、凭据、授权、DSH 进程、文件与网络能力  | backend library、shared |
| `packages/shared/*`   | 与运行环境无关的类型、校验、存储格式和纯流程逻辑 | 其他 shared             |

- `apps/*` 现有 `web`、`mobile`、`desktop`、`server`。声明 `aura.kind: app` 与 `aura.platform`，不声明 `aura.layer`。Web 与 Capacitor mobile 依赖 frontend/shared，server 依赖 backend/shared，Electron desktop 可组合 frontend/backend/shared。应用保持薄宿主，只拥有运行、构建与平台生命周期。
- `packages/*` 下每个包声明 `aura.kind: library` 和与目录一致的 `aura.layer`。
- frontend 不依赖 backend；shared 不依赖 React、浏览器 DOM、Capacitor、Electron、Node 服务或任何持有密钥的代码。
- 任何 workspace 都不得导入或依赖应用。应用之间不互相依赖 `dist`，各自独立构建同一个 library。
- 跨 workspace 使用包名与显式 `exports`，不使用跨包相对导入或私有源码子路径。
- 新增小程序这类平台时创建独立的 `apps/miniprogram`，复用适合该运行时的 shared 逻辑，不在 `packages/*` 里伪装成应用。

`pnpm run check:workspaces` 校验目录元数据、依赖方向、`workspace:*`、显式导出、未声明依赖、私有子路径、跨包相对导入、应用被依赖和依赖环。新增或移动包后先跑它。

## 各包边界

现有包：frontend 为 `workbench`、`ui`、`plugin-ui`；backend 为 `runtime`、`agent-runtime`、`workspace`、`orchestration`、`plugin-manager`、`plugin-sdk`、`dsh-auth`；shared 为 `protocol`、`core`、`demo`。

容易越界的几处：

- `runtime` 是后端组合根。配置、HTTP 路由、DSH 进程执行、本地模型适配和生命周期各自独立成 TypeScript 模块。它不执行业务 Flow，也不拥有业务持久化。
- `agent-runtime` 拥有 Agent 会话执行、索引、历史、权限、协作和自动化。
- `workspace` 拥有目录注册、工作区绑定校验和终端生命周期。
- `orchestration` 拥有 Action 与 Flow 执行、恢复、运行记录、产物和插件后端能力。
- `plugin-manager` 的插件发现是只读的，不执行也不安装插件。
- `plugin-sdk` 只导出公开的 Action/Flow/provider、backend、storage、media、browser、errors 契约，不暴露运行时组合、凭据或 DSH 内部。
- `dsh-auth` 只组合 DSH 授权与凭据适配，不放 HTTP 路由和模型执行。
- `workbench` 只保留通用对话、工作流与设置；业务页面由插件通过页面贡献注入，不在宿主硬编码导航。

名称描述职责或领域含义，避免含糊的 `data`、`manager`、`utils` 模块。函数和模块保持一个明确的变化原因。

凭据的归属是分层规则的一部分：模型与 OAuth 凭据只由 backend 包持有，保存在被忽略的 `.aura/` 存储下。frontend 与 shared 不得出现读取或转发凭据的代码。

## 技术栈与依赖

选型已经固定，新增依赖前先确认它不属于下面被排除的那一类。

- **TypeScript。** Aura 的 JavaScript 运行时代码用 TypeScript 写：应用、包、脚本和测试源码用 `.ts`（JSX 用 `.tsx`），不新增也不直接使用 `.mjs`，不写手写实现加 `.d.ts` 的成对文件。保持 Node.js 24 可直接擦除执行的语法，除非明确需要构建产物。
- **HTTP 用 Hono** 及其官方运行时适配器。不要直接用 `node:http` 搭应用的 HTTP server、路由、body parser、静态文件服务或流式协议；裸 Node HTTP 只保留给框架适配器或有文档记录的互操作需求。
- **Web-first。** 可复用 UI 用 React DOM，Web renderer 用 Vite，桌面宿主用 Electron，移动宿主用 Capacitor。不添加 Expo、React Native、React Native Web 或 Metro 依赖。浏览器、Electron renderer 与 Capacitor 共用同一套 DOM 实现。
- **DSH 作为已发布依赖使用**，Aura 行为通过它的插件和服务缝隙接入，不复制也不修改 DSH、pi-ai 的源码或 `node_modules` 下的文件。模型 provider 与交互式授权必须经过 DSH。
- **pnpm。** 从仓库根使用，保持唯一的 `pnpm-lock.yaml`，workspace 依赖用 `workspace:*`，不添加 npm 或 Yarn 的 lockfile。根开发工具依赖放根 `devDependencies`，应用和库依赖放实际使用它的 workspace。
- **单份 React 运行时。** React、React DOM 及 renderer 级 UI 运行时在可复用 frontend UI 库中声明为 peer dependency，由应用提供唯一一份。

## 文件与命名

- 新的普通模块用 `kebab-case.ts`，组件用 `PascalCase.tsx`，Hook 用 `useXxx.ts`。扩展现有目录时沿用该目录的命名习惯，不为引入规范批量重命名旧文件。
- 包内 `src/` 放实现，`test/` 放测试，`README.md` 说明该包职责、公共接口与检查方式。
- 根开发工具依赖放根 `devDependencies`，应用和库依赖放实际使用它的 workspace。

## 插件放置

产品插件在根 `plugins/`，每个插件一个独立目录，允许 `plugins/<category>/<plugin>/` 分类。当前包括 `plugins/site-launcher` 和 `plugins/tripo`。基础宿主、运行时、公共 SDK 和共享协议留在 `packages/*`。

`plugins/*` 不在 pnpm workspace 内，各插件自带 ESLint、Prettier 与 TypeScript 配置：

| 命令                             | 作用                                   |
| -------------------------------- | -------------------------------------- |
| `pnpm run setup:product-plugins` | 准备开发期链接                         |
| `pnpm run build:product-plugins` | 构建插件产物                           |
| `pnpm run check:product-plugins` | 准备、构建、类型检查、Lint、格式和测试 |
| `pnpm run build:plugins`         | 更新 server 与 desktop 两份分发产物    |

放置规则：

- 插件自带业务后端、前端、Actions、Flows、presets 和 HTTP adapter。宿主只保留通用的工作流执行、模型与凭据中介、存储和插件生命周期端口；不要为某个插件新增常驻的宿主 facade。
- `plugins/` 是默认的受信任发现根。发现递归进入分类目录，遇到 `aura.plugin.json` 即停止下探，跳过隐藏/生成/依赖目录和目录链接。`.aura/plugins.json` 的显式条目按路径或插件 ID 覆盖，包含停用状态和插件自有设置。源码迁移绝不改写用户配置。
- 把插件搬目录或改 ID 时，原有的 domain 名称、存储格式和 ID 靠显式 compatibility 授权保留，不靠改写用户配置或数据。

## 外部业务插件

- 两个仓库之间唯一的耦合是插件 manifest 的 `engines.pluginSdk` 与宿主 `@aura/plugin-sdk` 版本（以本仓库 `packages/backend/plugin-sdk/package.json` 的版本为准）的 semver 范围检查。宿主在加载时提供 `@aura/plugin-sdk`，工作台向页面 bundle 注入 React、`@aura/plugin-ui` 和 `@aura/workbench/*`；插件不打包这些。
- 改动 SDK 公开契约时同步更新其版本与 README，并说明对 aura-studio 的影响。不要为了迁就某个 studio 插件把业务逻辑搬回宿主。
- 在本仓库写文档或注释时，指向 aura-studio 的插件要写明它在独立仓库，不要写成 `plugins/` 下的路径。

## 临时文件与正式产物

- Agent 临时脚本、一次性工具、日志、截图、调试输出和下载物统一放项目根 `local/`，按需创建，可按任务建子目录。
- 不得在源码、文档、规则目录或项目根散落写入临时文件。`local/` 可整体删除，不存放需要保留或交付的内容。
- 源码、构建配置和正式文档不得引用或依赖 `local/`。长期工具进入正式工具目录，正式交付文件放约定位置。
- 测试使用框架管理或系统隔离的临时目录并自行清理，不依赖仓库 `local/`，不修改真实用户数据。
- 框架管理的构建产物、缓存和用户明确指定的输出位置沿用其既有约定。

根 `/local/` 已被 Git 忽略；长期工具放 `scripts/`。
