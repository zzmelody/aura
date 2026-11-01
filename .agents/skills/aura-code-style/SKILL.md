---
name: aura-code-style
description: Aura 自有代码的项目全局规范。在编写或审查宿主 TypeScript/React、产品插件 JavaScript、脚本与测试，或处理格式与 Lint 问题时使用；按语言和目录选择本 skill 内的细则。
---

# Aura 代码规范

本规范自包含，禁止依赖项目外的规范或指引，不链接、调用或要求加载其他 skill。支持文件只放在本 skill 目录内，内部文件可以互相引用。项目源码、工具配置及记录是事实输入，不是外置规则。

## 按代码范围读取

- 宿主 `apps/*`、`packages/*`、根脚本和测试：读取 [TypeScript 与 React](references/typescript-react.md)。
- 插件原生 ESM JavaScript：读取 [插件 JavaScript](references/plugin-javascript.md)。插件后端或页面 TypeScript 同时采用适用的 TypeScript 规则及该插件配置。
- 保留目标目录已有的明确例外；产品 `site-launcher` 使用双引号与根锁文件，不把新插件默认值强行应用于旧代码。

## 共同边界

- 仅格式化本次修改范围；格式和行为变更分别审查，不因规范整理改名公共字段、注册 ID、提示词、正则或嵌入源码。
- 异步工作明确等待和失败处理，传播取消；输入先校验，资源由明确所有者释放。
- 凭据只留在 backend，不进入响应、日志或上下文；用户配置写入保留 revision 检查，未知付费结果不自动重发。
- 格式由实际 Prettier 配置决定，Lint 由目标配置执行。不扩大历史基线或关闭规则掩盖问题，未运行的检查不能记为通过。
