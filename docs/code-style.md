# Aura 代码规范

本规范约束 Aura 自有源码。包职责、依赖方向和凭据边界继续遵循 [AGENTS.md](../AGENTS.md) 与 [架构](architecture.md)。工具配置是格式与静态检查的执行依据；下面的设计约定用于开发和评审。

## 采用的规范

语言与模块设计以 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) 为基础，React 补充采用官方 [Rules of Hooks](https://react.dev/reference/eslint-plugin-react-hooks/lints/rules-of-hooks) 和 [Effect 依赖规则](https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps)。ESLint 使用官方推荐规则与 typescript-eslint 的 TypeScript 规则承接这些要求，Prettier 负责具体排版；这是一份明确适配的 Google 规范，不声称全量符合 Google 内部工具链。

| 约定                                                    | Aura 执行方式                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `const` / `let`、单变量声明、构造函数命名、对象迭代保护 | ESLint `prefer-const`、`no-var`、`one-var`、`new-cap`、`guard-for-in` |
| 简单数组用 `T[]`，不使用数组构造器和包装对象            | `array-type`、`no-array-constructor`、`no-new-wrappers`               |
| 类型名称使用 `PascalCase`，优先明确类型和 `unknown`     | `naming-convention`、`no-explicit-any` 与 TypeScript 严格检查         |
| 复用模块使用具名导出，不导出可重新赋值的绑定            | library `src` 中的 `no-restricted-syntax`                             |
| ES modules，区分类型与值                                | TypeScript 推荐规则与 `consistent-type-imports`                       |
| Hook 调用与完整依赖                                     | React 官方 `rules-of-hooks`、`exhaustive-deps`                        |
| 业务命名、错误上下文、取消、模块职责                    | 开发与代码评审；不宣称 Lint 能完全验证                                |

Aura 的显式适配：

- Google 普通字符串使用单引号；Aura 保留现有双引号，由 Prettier 统一。空格、换行与 JSX 排版也以 Prettier 输出为准。
- 文件名保持现有 `kebab-case` / `PascalCase` / `useXxx` 习惯，不迁移 Google 的文件命名方式。类型和业务符号继续遵循上述命名约定。
- Google 偏好具名导出；框架配置、DSH Flow/Action 入口以及共享 React 宿主根 `App.tsx` 允许默认导出，复用库其他模块使用具名导出。
- Google 对 `any` 允许有理由的例外；Aura 默认将新增显式 `any` 作为错误，兼容第三方接口或测试 mock 时必须用具体规则的行级禁用并解释原因。未使用接口参数可保留 `_` 前缀。
- Google 的部分 TypeScript 语法无法由 Node.js 24 直接擦除执行；Aura 的 `erasableSyntaxOnly`、workspace 边界、Hono、DSH 与凭据规则优先，不引入另一套构建或运行链路。
- DSH 的 `MessageId`、`SessionId`、`ToolCallId` 和 `ReasoningEffortId` 是公开的品牌类型工厂，沿用其名称且不使用 `new`。有意检测或清理 ASCII 控制字符的正则，保留带理由的单行 `no-control-regex` 例外。

## 格式与命名

- 使用 UTF-8、LF、文件末尾换行；TypeScript、TSX、JSON、CSS 缩进为两个空格，PowerShell 为四个空格。
- Prettier 统一格式：双引号、分号、允许尾逗号，目标行宽 80。不要手工维护与格式化器冲突的排版。
- 变量和函数使用 `camelCase`；类型、类、React 组件使用 `PascalCase`；模块级固定常量可以使用 `UPPER_SNAKE_CASE`。
- 新的普通模块使用 `kebab-case.ts`，组件文件使用 `PascalCase.tsx`，Hook 使用 `useXxx.ts`。扩展现有目录时保持该目录的命名习惯，不因引入规范批量重命名旧文件。
- 名称描述职责或领域含义，避免含糊的 `data`、`manager`、`utils` 模块。重复使用的逻辑按职责提取，函数和模块保持一个明确的变化原因。

## TypeScript 与模块

- 新的应用、包、脚本和测试使用 `.ts` / `.tsx`，保持 Node.js 24 可直接执行的语法。现有受信任 Flow/Action 的 `.js` 入口逐步迁移，不新增 `.mjs` 或手写实现/声明成对文件。
- 保持 TypeScript `strict` 与 `erasableSyntaxOnly`。导出的协议、服务端口和公共函数明确输入、输出类型；局部变量优先使用类型推断。
- 外部 JSON、HTTP 输入和捕获异常先视为 `unknown`，经校验或类型收窄后使用。禁止新增显式 `any`，不要通过类型断言掩盖未验证的数据。
- 仅用于类型的导入使用 `import type`。优先 `const`，需要重新赋值才使用 `let`，不使用 `var`。比较使用严格相等；明确检查空值的 `value == null` 允许保留。
- 移除未使用的导入和变量；接口要求但不使用的参数以 `_` 开头。跨 workspace 使用包名与公开 `exports`，不导入私有源码路径。
- 根开发工具依赖放在根 `devDependencies`，应用和库依赖放在实际使用它们的 workspace。使用根 `package.json` 的 `packageManager` 版本与唯一 `pnpm-lock.yaml`。

## 异步、错误与副作用

- 异步调用明确等待、返回或处理失败。后台任务必须有失败处理与关闭路径；可取消操作向下传递 `AbortSignal`。
- 在系统边界校验输入，在拥有上下文的层转换错误。面向用户的错误说明失败阶段和可采取的操作，日志不包含 token、API Key 或完整授权响应。
- 不静默吞掉业务失败。资源关闭等尽力清理允许空 `catch`，但应说明忽略失败的原因。当前 Lint 允许这类语法，评审负责检查使用理由。
- 文件、网络、进程、模型和凭据操作保留在 backend。外部副作用的超时、取消、幂等与重试按领域约定实现；未知付费结果不自动重发。

## React

- 保持同一套 React DOM 实现，应用只提供平台宿主。组件渲染不执行网络、文件或其他外部副作用。
- Hook 只能在组件或自定义 Hook 顶层调用；Effect、memo 和 callback 声明完整依赖。不要通过关闭规则绕过闭包中的过期值。
- Effect 返回订阅、定时器或请求的清理逻辑。可以从现有状态计算出的值不再保存一份状态；领域交互逻辑放进职责明确的 Hook 或模块。
- 不为每个函数添加 `useCallback` / `useMemo`；只在引用稳定性有明确用途或性能证据时使用。

## 检查与历史问题

| 命令                                | 用途                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `pnpm run format:check`             | 检查新增、修改和已规范化文件；允许内容未变的历史格式问题                   |
| `pnpm exec prettier --write <文件>` | 整理本次修改的文件                                                         |
| `pnpm run format`                   | 格式化整个仓库，适合单独的格式整理改动                                     |
| `pnpm run format:check:strict`      | 全量格式检查，包含历史问题                                                 |
| `pnpm run lint`                     | ESLint 推荐规则、TypeScript 规则和 React Hook 检查；阻止历史数量以外的违规 |
| `pnpm run lint:strict`              | 全量 Lint，不豁免历史问题；也可在命令后传入指定文件                        |
| `pnpm run lint:fix`                 | 自动修复可安全修复的 Lint 问题，再报告剩余问题                             |
| `pnpm run lint:prune`               | 移除已修复问题对应的 ESLint 历史条目                                       |
| `pnpm run check`                    | 格式、Lint、workspace 边界、类型检查和测试；现有 CI 使用同一入口           |

格式历史记录位于根 `format-baseline.json`，只记录未格式化文件原内容的 SHA-256（换行归一化后计算），不忽略整份文件。新增文件或内容变化后必须通过 Prettier。已格式化文件再次出现格式问题也会失败；过时条目可以删除，不影响检查。检查扫描 Git 跟踪和未忽略的新文件，跳过生成物、依赖、原生工程与无对应格式化器的二进制文件。

Lint 历史记录位于根 `eslint-suppressions.json`，使用 [ESLint 官方 bulk suppressions](https://eslint.org/docs/latest/use/suppressions) 按文件与规则记录现有违规数量。它不是逐行豁免：同一旧文件、同一规则在历史数量内仍可能被豁免。修改相关代码时应主动清理该规则的旧问题，并运行 `lint:prune`；不要以重新生成或扩大历史清单的方式让检查通过。修复后遗留的无效 Lint 条目会使检查失败。

如需查看某个文件包含历史问题在内的完整 Lint 结果，运行 `pnpm run lint:strict <文件>`。它使用 ESLint API 返回全部违规，不读取根历史清单。

2026-10-08 整理后，两份基线均为空；全仓严格格式和 Lint 检查作为本轮交付门禁。基线机制仅保留工具兼容性，不能重新生成或扩大来隐藏违规。新增规则需要在改动说明中解释原因；临时 `eslint-disable-next-line` 必须指定具体规则并说明理由，未使用的禁用指令会报错。

开发时先执行受影响包的检查。非平凡行为变化补充聚焦测试和相关文档；跨仓库结构或工具规则变化完成 `pnpm run check`。测试关注行为、失败路径、取消和恢复，不只复述实现。
