---
name: aura-testing
description: Aura 的测试规范：node:test 用法、测试文件放置与命名、临时目录清理、跳过与环境门控、付费与真机依赖的处理，以及各层检查命令的执行顺序。在新增或修改测试、排查测试失败、或判断某个行为改动需要补哪种测试时加载。
---

# Aura 测试规范

测试用 Node.js 内置 `node:test` 与 `node:assert/strict`，不引入第三方测试框架、断言库或 mock 库。

## 放置与运行

- 包内测试放 `packages/<layer>/<pkg>/test/*.test.ts`，由该包的 `pnpm run test` 执行。
- 跨包和脚本层测试放根 `tests/*.test.ts`，由根 `pnpm run test` 执行（`tsx --test tests/*.test.ts`）。
- 插件测试放 `plugins/<plugin>/test/*.test.ts`，由 `pnpm run check:product-plugins` 执行。
- 大多数包用 `tsx --test test/*.test.ts`；`@aura/workbench` 用 `node --test test/*.test.ts`。新增包沿用同层既有包的写法。
- 文件名用 `kebab-case.test.ts`，贴近被测领域（`plugin-storage.test.ts`、`nested-flow.test.ts`）。共享 fixture 用不带 `.test` 的同目录模块（`fixture-ports.ts`、`plugin-backend-fixture.ts`），数据放 `test/fixtures/`。

## 写法

- 用平铺的顶层 `test("...", async () => {})`，不套 `describe`（全仓仅一处历史用法）。
- 测试名是一句说明被验证行为的话，描述行为而非实现：`"Action host capabilities are limited to manifest grants"`，不是 `"actionCapabilities works"`。
- 断言一律 `import assert from "node:assert/strict"`。
- 导入被测模块用相对路径加扩展名（`../src/actions.ts`），跨包用包名。
- 测试代码同样遵守 [aura-code-style](../aura-code-style/SKILL.md)；测试 mock 需要 `any` 时用针对具体规则的行级禁用并说明原因。

## 隔离与清理

- 需要文件系统的测试用 `mkdtemp(join(tmpdir(), "aura-<area>-"))` 建独立临时目录，并立刻注册清理：

  ```ts
  const root = await mkdtemp(join(tmpdir(), "aura-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  ```

- 起的服务器、子进程、定时器和订阅都在 `t.after` 里关掉。测试不得依赖执行顺序或互相残留的状态。
- 不写仓库工作区、不碰真实 `.aura/` 存储、不改用户配置。

## 跳过与环境门控

用 `test(name, { skip: <reason | false> }, fn)` 表达条件跳过，理由写成人能读懂的一句话：

```ts
test("DSH agent loop streams events", {
  skip: nodeMajor < 24 ? "DSH requires Node >=24" : false,
}, async () => {});
```

- 依赖真实账号、付费模型或本机外部服务的测试默认跳过，用 `AURA_TEST_*` 环境变量显式开启（现有 `AURA_TEST_COMFY_WORKFLOW`、`AURA_TEST_LOCAL_AI`、`AURA_TEST_LOCAL_AI_ACTION`）。新增同类测试沿用这个命名。
- 默认 `pnpm run test` 必须在没有凭据、没有外部服务的机器上通过。
- 合成样本不能当作某个付费平台已接入的证明。用合成接口样本时在测试或文档里标明它是合成数据。

## 覆盖什么

非平凡行为变化补聚焦测试。测试关注行为、失败路径、取消和恢复，不只复述实现。

- 新增能力：正常路径，加上空结果、缺字段和上游失败。
- 修 bug：先写能复现该 bug 的测试。
- 边界与契约：HTTP 路由的解析与投影、协议校验、存储格式与版本恢复。
- 可取消的工作：验证 `AbortSignal` 真的中断，并且中断后状态干净。
- 持久化：验证重启后能恢复，旧版本格式仍可读。
- 凭据：验证 token、API Key 不出现在响应、日志和前端 DTO 里。

## 交付

先跑受影响的包，再按改动范围扩大：

| 场景                   | 命令                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| 受影响包（先跑）       | `pnpm --filter <pkg> run typecheck`、`pnpm --filter <pkg> run test` |
| 源码改动               | `pnpm run format:check`、`pnpm run lint`                            |
| 改动 `plugins/*`       | `pnpm run check:product-plugins`                                    |
| 跨包结构或工具规则改动 | `pnpm run check`                                                    |

`pnpm run check` 依次执行产品插件检查、格式、Lint、workspace 边界、类型检查和测试，与 CI 同一入口。格式与 Lint 的细分命令见 [代码规范](../aura-code-style/SKILL.md)。

非平凡行为变化同时更新所属包的 README、相关功能文档和聚焦测试。包内 README 说明该包的职责、公共接口与检查方式；跨包架构和用户功能文档在 `docs/`，新增文档同时更新 [文档目录](../../../docs/README.md)。

验证记录只写实际执行过的结果：跳过的写明跳过，失败的贴输出，没跑的说没跑。不把合成样本或未执行的检查写成通过，不把"应该能过"写成通过。
