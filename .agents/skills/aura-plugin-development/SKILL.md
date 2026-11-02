---
name: aura-plugin-development
description: Design, create, or review Aura plugins with ESM Actions, Flows and a plugin backend, and optional workbench pages through the public UI SDK. Use for Aura plugin-system work, not Codex plugins.
---

# Aura Plugin Development

Build Aura's trusted local plugin system and its Action/Flow plugins without coupling plugins to frontend code or Aura runtime internals.

本规范自包含，禁止依赖项目外的规范或指引，不链接、调用或要求加载其他 skill。支持文件只放在本 skill 目录内，内部文件可以互相引用。项目源码、工具配置及记录是事实输入，不是外置规则。

## Required workflow

1. Keep plugin-host infrastructure in backend TypeScript packages and product plugins under root `plugins/`, outside the pnpm workspace. Frontend must not depend on backend; shared remains platform-neutral. Cross-package imports use declared public exports. Inspect the current orchestration APIs instead of assuming the target plugin host is already implemented.
2. Read [the v2 plugin specification](references/specification.md) completely before designing, creating, reviewing, or changing an Aura plugin or plugin-host contract.
3. Determine whether the task concerns:
   - host infrastructure inside Aura; implement this in backend TypeScript, or
   - an external plugin; author runtime contributions as native ESM JavaScript.
4. Action/Flow plugins use the existing catalog and schema-driven UI. A plugin has at most one backend (`contributes.backend`, `defineBackend`) and lists built-in host capabilities in `permissions`. Before creating, modifying or reviewing workbench pages or Run result renderers, read [the page extension](references/pages.md), including its shared visual styles. Reuse the host's theme variables and icon classes, verify the required host support, and use the public browser SDK separately from backend code.
5. For product business backends, read [the backend extension](references/backends.md) and use the public storage/workflow/media ports, private backend services, HTTP adapters and explicit compatibility grants. Keep product implementation in its plugin, not a host facade.
6. Preserve the trust boundary. Treat plugins as trusted local Node.js code: repository-owned `plugins/` is deployment-enabled by default; other directories require explicit configuration. Never describe manifest permissions as a security sandbox, expose OAuth/API credentials, or auto-install plugin dependencies during Aura startup.
7. Use public plugin SDK contracts. Do not make external plugins import private Aura source paths, application workspaces, `@aura/runtime`, or DSH/pi-ai internals.
8. Validate the narrow plugin or backend package first (`pnpm run check:product-plugins` for `plugins/*`), then widen to `pnpm run check` for cross-package contracts. Add focused behavior tests with node:test and node:assert/strict; isolate temporary state and clean it up. Real accounts, paid requests and external services require explicit environment gating. Report only checks actually run.

## JavaScript code style

Before creating or changing plugin JavaScript, read [the Airbnb-based authoring standard](references/javascript-code-style.md) and the target plugin's actual formatter/linter configuration. Apply the documented SDK exceptions. Keep one statement per line and complete control-flow blocks; expand complex schemas and tool-call objects.

Use the plugin's Prettier configuration for formatting and ESLint for quality checks. Format and lint only the task's changed files, and report legacy failures separately. Preserve contribution IDs, schema keys, durable step identities, cancellation and embedded source strings. Keep formatting-only patches separate from behavior changes. For a new plugin, provide these configurations and fixed development dependencies; never install them during Aura discovery or startup. Aura host TypeScript keeps the target repository's existing conventions.

## Authoring defaults

- In Aura, put non-foundational product plugins in independent directories under root `plugins/` (category subdirectories are allowed). Declare explicit runtime assets in `package.json#files` for server/desktop distribution, listing relative files and directories without globs; keep account data, keys, caches, exports and development `node_modules` out of releases, and let the release host install dependencies. Discovery is read-only and explicit user entries override deployment defaults. From the repository root use `pnpm run check:product-plugins` for validation and `pnpm run build:plugins` for server/desktop staging.
- Use `aura.plugin.json` plus `package.json` with `"type": "module"`.
- Use exact entry names `<id>.action.js` and `<id>.flow.js` under their contribution directories.
- Put a plugin's backend in one entry, conventionally `backend/index.ts` built to `backend/dist/index.js`, named by `contributes.backend` and default-exporting `defineBackend({ open(host) })`. Do not create `capabilities/` provider directories or top-level `capabilities`; those are v1 and are rejected.
- Prefer `// @ts-check` and the declarations exported by `@aura/plugin-sdk`; TypeScript authoring is optional and must compile to ESM JavaScript before Aura loads it.
- Require fully qualified contribution IDs at cross-plugin boundaries.
- Propagate `AbortSignal`, keep inputs and outputs JSON-serializable, and use only built-in capabilities granted by `permissions`.
- Compose work in Flows. Do not introduce nested Action-to-Action or Action-to-Flow execution.

If the repository does not yet provide the manifest host or `@aura/plugin-sdk`, do not pretend an external plugin is runnable. Implement the requested backend host seam first when that is in scope; otherwise identify the missing prerequisite clearly.

Agent temporary files belong in repository-root `local/`; tests use isolated temporary directories and clean them up. Never modify user configuration or stored IDs during a source relocation; preserve revision checks and reviewed compatibility grants.
