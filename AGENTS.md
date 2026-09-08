# Aura workspace rules

Read `docs/architecture.md` before changing package placement or dependencies.

## Application and package placement

- `apps/*` owns runnable and publishable entrypoints. Use `aura.kind: app` with `aura.platform: mobile`, `desktop` or `server`; applications do not declare `aura.layer`. Mobile apps may depend on frontend/shared libraries, server apps on backend/shared libraries, and desktop apps on frontend/backend/shared libraries.
- `packages/frontend/*` owns reusable user interfaces, interaction state, navigation and device adapters. Frontend packages may depend on frontend and shared packages, never backend packages.
- `packages/backend/*` owns HTTP services, secrets, authentication, DSH processes, filesystem and network providers. Backend packages may depend on backend libraries and shared packages, never frontend packages.
- `packages/shared/*` owns deterministic, runtime-neutral types, validation, storage formats and workflow logic. Shared packages may depend only on other shared packages and must not depend on React, Expo, Node services or secret-bearing code.
- Every package under `packages/*` declares `aura.kind: library` and its directory layer as `aura.layer`. No workspace may import or depend on an application.
- Use package names and explicit `exports` between workspaces. Do not use cross-package relative imports or private source subpaths.

## Dependency and credential rules

- Use pnpm from the repository root. Keep one `pnpm-lock.yaml`, use `workspace:*` for Aura workspace dependencies, and do not add npm or Yarn lockfiles.
- Keep model and OAuth credentials in backend packages under ignored `.aura/` storage. Never include access tokens, refresh tokens or API keys in frontend responses, logs, source files or client storage.
- Consume DSH as published dependencies and add Aura behavior through its plugins and service seams. Model providers and interactive provider authentication must flow through DSH; Aura must not call pi-ai directly. Do not copy or modify DSH or pi-ai source or files under `node_modules`.
- Keep React and React Native as peer dependencies of reusable frontend UI libraries so applications provide a single runtime copy.

Update affected documentation and focused tests with non-trivial behavior changes. Run the narrow package checks first, then `pnpm run check` before handing off repository-wide structural work.
