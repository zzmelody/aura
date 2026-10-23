# Site launcher plugin

Follow `../../docs/plugin-javascript-code-style.md`. Migrated sources retain Aura's
double quotes and the repository's single pnpm lockfile. The provider entry is
ESM JavaScript with `// @ts-check`; the TypeScript runner compiles to ESM JavaScript
before discovery. Never build or install dependencies during plugin startup.

Own project description, startup, port/process verification and cleanup here.
Electron supplies directory selection and preview windows only. Preserve existing
site storage keys. Never stop a process unless it belongs to this runner. Stop
owned projects on provider disposal; navigating away must not stop them.

Run `pnpm run check:product-plugins` from the repository root.
