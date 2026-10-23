# Aura workspace rules

Read `docs/architecture.md` before changing package placement or dependencies.
Follow the Google TypeScript Style Guide, with Aura's explicit adaptations and React rules in `docs/code-style.md`.

## Coding conventions and checks

- Use [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) as the language/design baseline. `docs/code-style.md` documents local overrides; existing workspace and runtime rules below take precedence.
- Let Prettier own formatting: two spaces, double quotes, semicolons, trailing commas and an 80-column target. Aura deliberately retains double quotes and existing file naming instead of Google's single quotes and filenames.
- Prefer `const`, named library exports, `import type`, specific types and `unknown` with validation. Do not add explicit `any`, unused imports or mutable exported bindings. Framework entrypoints and compatibility declarations follow the exceptions in the coding guide.
- Follow React's Rules of Hooks and declare complete effect/callback dependencies. Clean up subscriptions and cancellable work.
- Run `pnpm run format:check` and `pnpm run lint` for source changes. Format touched files with `pnpm exec prettier --write <files>`; run `pnpm run lint:prune` after fixing historical lint findings.
- Legacy baselines only record pre-existing debt. Never regenerate or expand them to hide new violations; document any narrowly scoped rule suppression and its reason.

## Application and package placement

- `apps/*` owns runnable and publishable entrypoints. Use `aura.kind: app` with `aura.platform: web`, `mobile`, `desktop` or `server`; applications do not declare `aura.layer`. Web and Capacitor mobile apps may depend on frontend/shared libraries, server apps on backend/shared libraries, and Electron desktop apps on frontend/backend/shared libraries.
- `packages/frontend/*` owns reusable React Web interfaces, interaction state, navigation and browser-safe host adapters. Frontend packages may depend on frontend and shared packages, never backend packages. Keep browser, Electron renderer and Capacitor UI in the same DOM implementation; platform apps should remain thin hosts.
- `packages/backend/*` owns HTTP services, secrets, authentication, DSH processes, filesystem and network providers. Backend packages may depend on backend libraries and shared packages, never frontend packages.
- `packages/backend/dsh-auth` owns DSH authorization/credential adapters. Provider-specific services may live there, but HTTP routes and model execution do not.
- `packages/backend/runtime` is the backend composition root. Keep configuration, HTTP routes, DSH process execution, local model adapters and lifecycle management in separate TypeScript modules; do not reintroduce `.mjs` plus handwritten `.d.ts` pairs.
- `packages/shared/*` owns deterministic, runtime-neutral types, validation, storage formats and workflow logic. Shared packages may depend only on other shared packages and must not depend on React, browser DOM, Capacitor, Electron, Node services or secret-bearing code.
- Every package under `packages/*` declares `aura.kind: library` and its directory layer as `aura.layer`. No workspace may import or depend on an application.
- Use package names and explicit `exports` between workspaces. Do not use cross-package relative imports or private source subpaths.

## External plugin JavaScript style

- Repository-owned, non-foundational product capabilities belong in root `plugins/`, each in an independent plugin directory. Category subdirectories are allowed (`plugins/<category>/<plugin>/`). Keep foundational host/runtime/SDK capabilities in `packages/*`; do not put production plugins in `examples/`.
- Product plugins own their business backend, frontend, Actions, Flows, presets and HTTP adapters. Host packages retain generic workflow execution, model/credential mediation, storage and plugin lifecycle ports; do not add permanent product-specific host facades. Relocations preserve legacy domain names, storage schemas and IDs through explicit reviewed compatibility grants, never by rewriting user data or bypassing revision checks.
- `plugins/` is a trusted default discovery root. Discovery recurses through category directories and stops at `aura.plugin.json`; it skips hidden/generated/dependency directories and directory links. Explicit `.aura/plugins.json` entries override the same path or plugin ID, including disabled state and plugin-owned settings. Never rewrite user configuration as part of a source migration.
- Ship repository plugins with server and desktop builds. Every plugin declares explicit relative runtime assets in `package.json#files` (no globs), including prebuilt page bundles and backend helpers. `scripts/build-plugins.ts` builds and stages these assets in application distribution directories. Never ship account data, keys, caches, exports, local reader runtimes or development `node_modules`; dependencies must be supplied by the release host/package installation. Do not install dependencies or build plugins during application startup.
- Use the repository-owned [Aura plugin development skill](.agents/skills/aura-plugin-development/SKILL.md) for Aura plugin and plugin-host work. Keep its `agents/` metadata and `references/` resources versioned with the skill.
- Before creating or changing external plugin Actions, Flows, capability providers or helpers, read [the Airbnb-based plugin JavaScript standard](docs/plugin-javascript-code-style.md) and the plugin's own `AGENTS.md`.
- Keep plugin runtime entries as native ESM JavaScript with `// @ts-check`. Apply Airbnb rules and the documented SDK exceptions. Use Prettier for formatting and ESLint for quality checks; do not compress statements or control-flow blocks into one line.
- Format and lint the files changed for the task. Preserve canonical contribution IDs, schemas, durable step IDs and embedded source strings. Keep formatting-only changes separate from behavior changes.
- This section applies to external plugin packages. Aura host code and built-in contributions retain the existing TypeScript rules and repository tool configuration.

## Dependency and credential rules

- Write Aura JavaScript-runtime code in TypeScript. Do not add or directly use `.mjs` files; prefer `.ts` (or `.tsx` for JSX) for application, package, script and test sources. Keep TypeScript directly executable by the repository's Node.js 24 baseline unless a build output is explicitly required.
- Build HTTP boundaries with Hono and its official runtime adapters. Do not create application HTTP servers, routers, body parsers, static-file servers or streaming protocols directly with `node:http`; raw Node HTTP access is reserved for framework adapters or a documented interoperability requirement.
- Use pnpm from the repository root. Keep one `pnpm-lock.yaml`, use `workspace:*` for Aura workspace dependencies, and do not add npm or Yarn lockfiles.
- Keep model and OAuth credentials in backend packages under ignored `.aura/` storage. Never include access tokens, refresh tokens or API keys in frontend responses, logs, source files or client storage.
- Consume DSH as published dependencies and add Aura behavior through its plugins and service seams. Model providers and interactive provider authentication must flow through DSH; Aura must not call pi-ai directly. Do not copy or modify DSH or pi-ai source or files under `node_modules`.
- Aura is Web-first. Use React DOM for reusable UI, Vite for Web renderers, Electron for the desktop host and Capacitor for mobile hosts. Do not add Expo, React Native, React Native Web or Metro dependencies.
- Keep React, React DOM and renderer-wide UI runtimes as peer dependencies of reusable frontend UI libraries so applications provide a single runtime copy.

Update affected documentation and focused tests with non-trivial behavior changes. Run the narrow package checks first, then `pnpm run check` before handing off repository-wide structural work.
