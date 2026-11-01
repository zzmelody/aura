# Aura 插件 JavaScript 规范

外部插件的 Flow、Action、插件后端、辅助模块和测试采用 Airbnb JavaScript Style Guide 为基础。
新增或修改插件 JavaScript 时使用本页及目标插件的实际工具配置。项目约定和公共 SDK 契约优先于上游建议。
本页适用于外部插件；Aura 宿主、内置贡献和其他仓库代码继续遵守现有 TypeScript 及工具配置。

## 排版和质量

- 一行一条语句。控制流使用完整花括号。禁止把多个写入、循环或分支压缩在一行。
- 复杂 schema、工具调用和返回对象分层展开。复杂条件使用具名变量或函数，禁止嵌套三元表达式。
- 默认使用 `const`，重新赋值时使用 `let`；禁止 `var`。使用严格相等比较。
- 名称表达业务含义。每个函数处理一项明确职责，保持校验、准备、执行和结果处理的边界。
- 使用原生 ESM、公共 SDK 和 `// @ts-check`。静态相对导入带扩展名。
- 注释说明原因、单位和契约。禁止 `eval`、动态函数构造和抛出非 Error 值。

Prettier 负责排版，ESLint 负责质量规则。新插件默认使用两空格、单引号、分号、尾逗号、LF 和 `printWidth: 80`。
换行宽度是目标，不是所有字符串的硬上限。现有插件的差异必须写入自己的规范；不要擅自改动宿主工具配置。

## 插件例外

- SDK 入口使用规定的 default export；公共辅助模块允许 named exports。
- 允许函数声明，不因排版改变初始化时序。
- 允许 `for...of` 和有意的顺序 `await`。操作依赖、预算和副作用决定并发；格式要求不能改变调度。
- 不重新赋值参数；在明确的所有权契约下允许修改参数属性。
- 保留贡献 ID、schema 字段、durable step ID、提示词、正则和内嵌源码的内容。
- 使用当前 Node.js 基线，不因上游浏览器假设增加 Babel 或 polyfill。

Airbnb 官方 `eslint-config-airbnb-base@15` 的 peer 范围是 ESLint 7/8。
使用 ESLint 10 的项目应采用 flat config，显式配置适用的 Airbnb 规则及项目例外，不使用强制 peer 安装绕过兼容性。
若只配置了规则子集，明确说明，不能称为完整官方预设。
ESLint 不重复配置 Prettier 的排版规则；命名、职责、取消和副作用边界仍需人工审查。

## Flow 和 Action 的执行边界

- 传播 `ctx.signal`。输入输出使用 SDK schema，保持有界、可序列化且不含凭据。
- 只对独立操作使用并发。保留稳定步骤和既有重放、取消、未知结果处理。
- 不为通过 lint 吞错、假成功或重试不可逆操作。
- 保留公共 SDK、导入无副作用和 Action/Flow 调用边界。代码规范不授予新增权限。

## 开发工具和检查

插件根应提供 Prettier 配置、ESLint 配置、固定版本的开发依赖和包管理器锁文件。
配置 `format`、`format:check`、`lint`、`lint:fix` 和 `check:style` 命令；依赖由开发者显式安装，Aura 不在发现或启动阶段安装。

```sh
pnpm exec prettier --write flows/example/example.flow.js
pnpm exec prettier --check flows/example/example.flow.js
pnpm exec eslint flows/example/example.flow.js --max-warnings 0
```

路径为示例，替换为本次修改文件。沿用目标插件已有包管理器，不混用锁文件。
只格式化任务涉及的文件，格式和行为修改分别审查。
历史夹具、不可变证据、生成资源和第三方依赖不参与自动排版。
检查全插件时准确报告历史问题，不靠大范围关闭规则或伪造通过来处理。
格式和 lint 与 schema、运行时契约、实际生成及渲染证据分别报告。
