---
name: aura-code-style
description: Aura 宿主 TypeScript 与 React 的代码规范：Google TypeScript 适配、命名、类型、异步与错误处理、Hook 规则，以及格式与 Lint 检查命令。在编写或审查 apps/_ 与 packages/_ 下的 TypeScript/TSX 代码、或处理格式与 Lint 失败时加载。外部插件 JavaScript 用 aura-plugin-development。
---

# Aura 代码规范

适用于 `apps/*` 与 `packages/*` 下的 Aura 宿主源码。外部插件的 ESM JavaScript 另有 [Airbnb 适配规范](../../../docs/plugin-javascript-code-style.md)。

完整规范、规则到 ESLint 的对应表和历史基线机制见 [代码规范](../../../docs/code-style.md)。本页是必须遵守的条目。

## 基线

Node.js 24（`>=24.0.0`）、pnpm 12.5.1。TypeScript `strict` 与 `erasableSyntaxOnly` 常开。

语言与模块设计以 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) 为基础，React 采用官方 Rules of Hooks 与 Effect 依赖规则。这是一份明确适配，不声称全量符合 Google 内部工具链。

## 格式

排版交给 Prettier，不手工维护与它冲突的排版。

- 双引号、分号、允许尾逗号，目标行宽 80。
- UTF-8、LF、文件末尾换行。TypeScript、TSX、JSON、CSS 缩进两空格，PowerShell 四空格。
- Aura 刻意保留双引号和现有文件命名，不迁移 Google 的单引号与文件命名方式。

## 命名

- 变量和函数 `camelCase`；类型、类、React 组件 `PascalCase`；模块级固定常量可用 `UPPER_SNAKE_CASE`。
- 名称描述职责或领域含义。重复逻辑按职责提取，函数和模块保持一个明确的变化原因。

## TypeScript

- 保持 Node.js 24 可直接擦除执行的语法，除非明确需要构建产物。源码一律 `.ts` / `.tsx`，不新增 `.mjs`，不写手写实现加 `.d.ts` 的成对文件（技术栈约束见 [项目结构](../aura-project-structure/SKILL.md)）。
- 优先 `const`，需要重新赋值才用 `let`，不用 `var`。比较用严格相等；明确检查空值的 `value == null` 可以保留。
- 简单数组用 `T[]`，不用数组构造器和包装对象。
- 导出的协议、服务端口和公共函数明确输入输出类型；局部变量优先类型推断。
- 外部 JSON、HTTP 输入和捕获的异常先视为 `unknown`，校验或收窄后再用。不要用类型断言掩盖未验证的数据。
- 不新增显式 `any`。兼容第三方接口或测试 mock 时用针对具体规则的行级禁用并说明原因。
- 仅用于类型的导入用 `import type`。移除未使用的导入和变量；接口要求但不使用的参数以 `_` 开头。
- 复用模块用具名导出，不导出可重新赋值的绑定。框架配置、DSH Flow/Action 入口和共享 React 宿主根 `App.tsx` 允许默认导出。

## 异步、错误与副作用

- 异步调用明确等待、返回或处理失败。后台任务必须有失败处理与关闭路径；可取消操作向下传递 `AbortSignal`。
- 在系统边界校验输入，在拥有上下文的层转换错误。面向用户的错误说明失败阶段和下一步操作，不含 token、API Key、私有路径、签名 URL 或原始上游响应。
- 不静默吞掉业务失败。资源关闭这类尽力清理允许空 `catch`，但要说明忽略失败的原因。
- 文件、网络、进程、模型和凭据操作留在 backend。日志和错误消息不拼接 token、API Key 或完整授权响应；要输出凭据相关信息时只写键名，不写值。
- 写入 `.aura/` 下的配置或存储前确认这是用户发起的操作。读改写序列保留 revision 检查，不为了让重构通过而放宽它。

凭据、DSH、用户数据和付费请求的完整约束见根 [AGENTS.md](../../../AGENTS.md)，它不依赖本 skill 加载。

## React

- 保持同一套 React DOM 实现，应用只提供平台宿主。组件渲染不执行网络、文件或其他外部副作用。
- Hook 只在组件或自定义 Hook 顶层调用。Effect、memo 和 callback 声明完整依赖，不要关掉规则绕过闭包中的过期值。
- Effect 返回订阅、定时器和请求的清理逻辑。能从现有状态算出的值不再存一份状态；领域交互逻辑放进职责明确的 Hook 或模块。
- 不给每个函数加 `useCallback` / `useMemo`，只在引用稳定性有明确用途或有性能证据时使用。
- React 运行时由应用提供唯一一份，可复用 UI 库把它声明为 peer dependency（见 [项目结构](../aura-project-structure/SKILL.md)）。

## 检查

| 场景                   | 命令                                        |
| ---------------------- | ------------------------------------------- |
| 整理本次改动的文件     | `pnpm exec prettier --write <files>`        |
| 源码改动的必跑检查     | `pnpm run format:check`、`pnpm run lint`    |
| 看某个文件的全部违规   | `pnpm run lint:strict <file>`               |
| 自动修复可安全修复的项 | `pnpm run lint:fix`                         |
| 清理历史 Lint 条目之后 | `pnpm run lint:prune`                       |
| 全量格式检查           | `pnpm run format:check:strict`              |
| 单独的格式整理改动     | `pnpm run format`                           |

`format-baseline.json` 和 `eslint-suppressions.json` 目前均为空，全仓严格格式与 Lint 就是当前门禁。不要重新生成或扩大这两份基线来让检查通过；修复后遗留的无效条目会让检查失败，清理后跑 `lint:prune`。

必要的规则抑制写成针对具体规则的 `eslint-disable-next-line` 并说明理由。未使用的禁用指令会报错。
