# Aura workspace rules

Read `docs/architecture.md` before changing package placement or dependencies.

## Application and package placement

- `apps/*` owns runnable and publishable entrypoints. Use `aura.kind: app` with `aura.platform: web`, `mobile`, `desktop` or `server`; applications do not declare `aura.layer`. Web and Capacitor mobile apps may depend on frontend/shared libraries, server apps on backend/shared libraries, and Electron desktop apps on frontend/backend/shared libraries.
- `packages/frontend/*` owns reusable React Web interfaces, interaction state, navigation and browser-safe host adapters. Frontend packages may depend on frontend and shared packages, never backend packages. Keep browser, Electron renderer and Capacitor UI in the same DOM implementation; platform apps should remain thin hosts.
- `packages/backend/*` owns HTTP services, secrets, authentication, DSH processes, filesystem and network providers. Backend packages may depend on backend libraries and shared packages, never frontend packages.
- `packages/backend/dsh-auth` owns DSH authorization/credential adapters. Provider-specific services may live there, but HTTP routes and model execution do not.
- `packages/backend/runtime` is the backend composition root. Keep configuration, HTTP routes, DSH process execution, local model adapters and lifecycle management in separate TypeScript modules; do not reintroduce `.mjs` plus handwritten `.d.ts` pairs.
- `packages/shared/*` owns deterministic, runtime-neutral types, validation, storage formats and workflow logic. Shared packages may depend only on other shared packages and must not depend on React, browser DOM, Capacitor, Electron, Node services or secret-bearing code.
- Every package under `packages/*` declares `aura.kind: library` and its directory layer as `aura.layer`. No workspace may import or depend on an application.
- Use package names and explicit `exports` between workspaces. Do not use cross-package relative imports or private source subpaths.

## Dependency and credential rules

- Write Aura JavaScript-runtime code in TypeScript. Do not add or directly use `.mjs` files; prefer `.ts` (or `.tsx` for JSX) for application, package, script and test sources. Keep TypeScript directly executable by the repository's Node.js 24 baseline unless a build output is explicitly required.
- Build HTTP boundaries with Hono and its official runtime adapters. Do not create application HTTP servers, routers, body parsers, static-file servers or streaming protocols directly with `node:http`; raw Node HTTP access is reserved for framework adapters or a documented interoperability requirement.
- Use pnpm from the repository root. Keep one `pnpm-lock.yaml`, use `workspace:*` for Aura workspace dependencies, and do not add npm or Yarn lockfiles.
- Keep model and OAuth credentials in backend packages under ignored `.aura/` storage. Never include access tokens, refresh tokens or API keys in frontend responses, logs, source files or client storage.
- Consume DSH as published dependencies and add Aura behavior through its plugins and service seams. Model providers and interactive provider authentication must flow through DSH; Aura must not call pi-ai directly. Do not copy or modify DSH or pi-ai source or files under `node_modules`.
- Aura is Web-first. Use React DOM for reusable UI, Vite for Web renderers, Electron for the desktop host and Capacitor for mobile hosts. Do not add Expo, React Native, React Native Web or Metro dependencies.
- Keep React, React DOM and renderer-wide UI runtimes as peer dependencies of reusable frontend UI libraries so applications provide a single runtime copy.

Update affected documentation and focused tests with non-trivial behavior changes. Run the narrow package checks first, then `pnpm run check` before handing off repository-wide structural work.
