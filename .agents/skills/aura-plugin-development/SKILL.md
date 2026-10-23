---
name: aura-plugin-development
description: Design, create, or review Aura plugins with ESM backend Actions, Flows and capability providers, and optional workbench pages through the public UI SDK. Use for Aura plugin-system work, not Codex plugins.
---

# Aura Plugin Development

Build Aura's trusted local plugin system and its Action/Flow plugins without coupling plugins to frontend code or Aura runtime internals.

## Required workflow

1. When working in the Aura repository, read its `AGENTS.md` and `docs/architecture.md` before changing placement or dependencies. Inspect the current orchestration APIs instead of assuming the target plugin host is already implemented.
2. Read [the v1 plugin specification](references/specification.md) completely before designing, creating, reviewing, or changing an Aura plugin or plugin-host contract.
3. Determine whether the task concerns:
   - host infrastructure inside Aura; implement this in backend TypeScript, or
   - an external plugin; author runtime contributions as native ESM JavaScript.
4. Preserve the original backend-only v1 contract: Action/Flow plugins use the existing catalog and schema-driven UI. When workbench pages are requested, read [the page extension](references/pages.md), verify the host implements it, and use its public browser SDK separately from backend code.
5. For product business backends, read [the backend extension](references/backends.md) and use the public storage/workflow/media ports, private provider services, HTTP adapters and explicit compatibility grants. Keep product implementation in its plugin, not a host facade.
6. Preserve the trust boundary. Treat plugins as trusted local Node.js code: repository-owned `plugins/` is deployment-enabled by default; other directories require explicit configuration. Never describe manifest capabilities as a security sandbox, expose OAuth/API credentials, or auto-install plugin dependencies during Aura startup.
7. Use public plugin SDK contracts. Do not make external plugins import private Aura source paths, application workspaces, `@aura/runtime`, or DSH/pi-ai internals.
8. Validate the narrow plugin or backend package first. For Aura repository changes, update focused tests and documentation, then run the repository check required by `AGENTS.md`.

## JavaScript code style

Before creating or changing plugin JavaScript, read [the Airbnb-based authoring standard](references/javascript-code-style.md) and the target plugin's local code-style instructions. Apply the documented SDK exceptions. Keep one statement per line and complete control-flow blocks; expand complex schemas and tool-call objects.

Use the plugin's Prettier configuration for formatting and ESLint for quality checks. Format and lint only the task's changed files, and report legacy failures separately. Preserve contribution IDs, schema keys, durable step identities, cancellation and embedded source strings. Keep formatting-only patches separate from behavior changes. For a new plugin, provide these configurations and fixed development dependencies; never install them during Aura discovery or startup. Aura host TypeScript keeps the target repository's existing conventions.

## Authoring defaults

- In Aura, put non-foundational product plugins in independent directories under root `plugins/` (category subdirectories are allowed), not `examples/`. Declare explicit runtime assets in `package.json#files` for server/desktop distribution; keep account data, keys, caches and development dependencies out of releases. Follow root `AGENTS.md` for discovery, overrides and packaging.
- Use `aura.plugin.json` plus `package.json` with `"type": "module"`.
- Use exact entry names `<id>.action.js` and `<id>.flow.js` under their contribution directories.
- Prefer `// @ts-check` and the declarations exported by `@aura/plugin-sdk`; TypeScript authoring is optional and must compile to ESM JavaScript before Aura loads it.
- Require fully qualified contribution IDs at cross-plugin boundaries.
- Propagate `AbortSignal`, keep inputs and outputs JSON-serializable, and use only declared Aura capability ports.
- Compose work in Flows. Do not introduce nested Action-to-Action or Action-to-Flow execution in v1.

If the repository does not yet provide the manifest host or `@aura/plugin-sdk`, do not pretend an external plugin is runnable. Implement the requested backend host seam first when that is in scope; otherwise identify the missing prerequisite clearly.
