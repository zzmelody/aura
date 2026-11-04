# Aura backend plugin specification

Status: v2 contract (manifest `schemaVersion: 2`, plugin SDK 2.0)\
Scope: trusted local plugins contributing Actions, Flows, one backend and optional workbench pages\
Runtime format: native ESM JavaScript\
Host implementation language: TypeScript

This specifies the plugin contract. Workbench pages are described in
[pages.md](pages.md) and product backend services in [backends.md](backends.md).
Version 1 manifests are not supported.

## 1. Normative language

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are requirements for implementations and plugin authors. This document defines the v2 contract. Before authoring a plugin, verify that the checked-out Aura version implements the required manifest schema and `@aura/plugin-sdk` version.

## 2. Design boundaries

Aura plugins extend backend orchestration and, optionally, the workbench through a prebuilt page bundle.

- The Aura plugin host, registries, configuration, capability adapters, and lifecycle code MUST be implemented in TypeScript under backend packages.
- Plugin Action and Flow entry modules MUST be native ESM JavaScript at runtime.
- Plugin authors MAY write TypeScript, but MUST compile it to ESM JavaScript before Aura loads it.
- Plugins contribute UI only through `contributes.pages` ([pages.md](pages.md)). They MUST NOT contribute host routes, Electron renderer code, or Capacitor UI any other way.
- External Flows MUST use the existing Flow catalog, JSON Schema form, execution, history, and result UI. Registering a plugin MUST NOT require a frontend rebuild.
- Actions are backend capabilities. They MAY be called by a Flow, granted to a DSH Agent, or invoked by an authorized backend host API. There is no generic direct-Action frontend.
- Plugins MUST use public SDK contracts and MUST NOT import Aura application workspaces, private source subpaths, `@aura/runtime`, pi-ai, or DSH internals.

## 3. Trust model

Plugins are trusted local code with the same effective Node.js authority as the Aura orchestration process.

- Repository-owned plugins under the deployment's `plugins/` directory are enabled by deployment policy. Other directories MUST be explicitly enabled by user configuration. An explicit disabled entry MUST override default discovery.
- Aura MUST NOT recursively search arbitrary drives or user directories for plugins.
- Aura MUST resolve and validate the plugin root and contribution roots before importing code. Contribution paths MUST remain inside the resolved plugin root.
- Aura MUST NOT run `npm install`, `pnpm install`, package lifecycle scripts, build commands, or downloads while starting or discovering a plugin.
- Missing dependencies MUST mark the affected plugin unavailable with a sanitized diagnostic.
- The manifest `permissions` list documents and gates built-in Aura services, but it is not a sandbox while plugins run in-process.
- Plugins MUST NOT read `.aura/dsh/.credentials.yaml`, receive OAuth grants or API keys through context, or include secrets in results and logs.
- Supporting untrusted plugins requires a later out-of-process RPC sandbox with filesystem, network, process, and resource policies; it is outside this contract.

## 4. Plugin package layout

A plugin is one self-contained directory:

```text
media-toolkit/
├─ aura.plugin.json
├─ package.json
├─ backend/
│  ├─ index.ts            # 源码；构建为 backend/dist/index.js（可选）
│  └─ dist/index.js       # contributes.backend 指向的已构建入口
├─ actions/
│  └─ image-info/
│     ├─ image-info.action.js
│     └─ lib/
│        └─ metadata.js
└─ flows/
   └─ media-report/
      ├─ media-report.flow.js
      └─ prompts.js
```

Requirements:

- `aura.plugin.json` and `package.json` MUST be at the plugin root.
- `package.json` MUST declare `"type": "module"`.
- A plugin MAY contribute only Actions, only Flows, or both.
- Action and Flow roots MUST contain only direct contribution directories. Arbitrary helper files belong inside the owning contribution directory.
- Each contribution directory MUST contain exactly one matching entry file:
  - `actions/<action-id>/<action-id>.action.js`
  - `flows/<flow-id>/<flow-id>.flow.js`
- Helper modules MAY be nested below the contribution directory and MUST use ESM imports.
- A plugin MAY declare one backend through `contributes.backend`: a single prebuilt native ESM file inside the plugin root that default-exports `defineBackend({ open(host) })` from `@aura/plugin-sdk/backend`. There is no backend directory scan and no per-provider ID; the backend is addressed by plugin ID.
- Runtime dependencies MUST already be installed in the plugin package. Aura discovery MUST remain read-only.

## 5. Manifest

The file `aura.plugin.json` uses UTF-8 JSON without executable values:

```json
{
  "schemaVersion": 2,
  "id": "melody.media-toolkit",
  "name": "Media Toolkit",
  "version": "0.1.0",
  "engines": {
    "aura": ">=0.1.0 <0.2.0",
    "pluginSdk": "^2.0.0"
  },
  "contributes": {
    "backend": "./backend/dist/index.js",
    "actions": "./actions",
    "flows": "./flows"
  },
  "permissions": [
    "aura.tripo.game-asset"
  ]
}
```

### 5.1 Required fields

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Integer `2`. Version 1 manifests (`contributes.capabilities` directories, top-level `capabilities`) and unknown versions MUST be rejected. |
| `id` | Stable lowercase publisher-qualified plugin ID. |
| `name` | Human-readable name, 1–80 characters. |
| `version` | Semantic version for the installed plugin revision. |
| `engines.aura` | Supported Aura semantic-version range. |
| `engines.pluginSdk` | Supported public plugin SDK range. |
| `contributes` | Object containing at least one of `actions`, `flows`, `backend` or `pages`. |

### 5.2 Optional fields

- `permissions` lists built-in host capabilities (IDs such as `aura.tripo.game-asset`, `aura.flow.invoke`) and defaults to an empty array; omit it when empty. A plugin's own backend is never listed here.
- `description`, `homepage`, and `license` MAY provide display metadata and MUST NOT affect execution.
- Unknown top-level fields MUST be rejected so misspelled security- or execution-related fields cannot be silently ignored.

The only executable entries are the prebuilt files named by `contributes` (`backend`, `http.entry`, `pages`) and the Action/Flow entry files. The manifest MUST NOT contain lifecycle scripts, shell commands, arbitrary environment variables, or remote download URLs.

## 6. Identifiers and namespacing

- Plugin IDs MUST match `^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$` and SHOULD contain a publisher prefix such as `melody.media-toolkit`.
- Local Action and Flow IDs MUST match `^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`.
- `aura` and the `aura.*` plugin namespace are reserved for built-in plugins.
- The canonical contribution ID is `<plugin-id>/<local-id>`, for example `melody.media-toolkit/image-info`.
- Catalogs, persistence, diagnostics, host invocation, and cross-plugin calls MUST use canonical IDs.
- The DSH tool adapter MAY map a canonical ID to an implementation-safe tool name, but persistence and public contracts MUST retain the canonical ID.
- Two enabled plugins MUST NOT claim the same plugin ID. Duplicate plugin or canonical contribution IDs MUST prevent the later plugin from activating; Aura MUST NOT use load order as an override mechanism.

## 7. Runtime configuration

Aura reads enabled roots from ignored backend configuration such as `<aura-root>/.aura/plugins.json`:

Aura also discovers its trusted repository/release `plugins/` directory recursively,
allowing category subdirectories and stopping at each `aura.plugin.json`. It skips
hidden/generated/dependency directories and does not follow directory links.
Explicit configuration overrides default entries by directory or plugin ID and
retains plugin-owned settings, including when disabled. Discovery MUST NOT write
user configuration. Repository plugins declare explicit relative runtime assets in
`package.json#files`; server and desktop builds MUST stage these with prebuilt page
bundles, excluding personal state, credentials, caches and development dependencies.
Distribution plugin directories are independent of the user's data root.

```json
{
  "version": 1,
  "plugins": [
    {
      "path": "D:/aura-plugins/media-toolkit",
      "enabled": true,
      "trust": "local"
    }
  ]
}
```

- Configuration parsing, canonical path resolution, manifest validation, and plugin status belong to a backend plugin manager.
- Relative paths MUST resolve against the configuration file directory, not the process working directory.
- `trust` MUST be `local`. Other values MUST be rejected rather than silently treated as trusted.
- Disabling a plugin prevents new runs from resolving its contributions. It MUST NOT mutate historical run records.
- Built-in Aura contributions and external plugin roots SHOULD pass through the same registry contracts, but built-ins MUST remain available without an external manifest.
- The runtime MAY also accept explicit programmatic plugin roots for tests and embedded hosts. Environment variables SHOULD be an operational override, not the canonical persisted configuration.

## 8. Discovery, loading, and HMR

The plugin manager validates packages; the orchestration host discovers their contribution directories.

1. Resolve the configured plugin directory and manifest.
2. Validate schema, engine ranges, path containment, ID uniqueness, and granted permissions.
3. Add each valid contribution root to the multi-root Action/Flow discovery service.
4. Register each entry through the existing Cordis Loader/HMR seam.
5. Publish plugin and contribution availability through backend catalog DTOs.

Behavioral requirements:

- Initial discovery MUST complete before the first catalog response is considered ready.
- Addition, removal, and changes MAY be detected by a bounded periodic scan and Cordis HMR.
- A successful load records the plugin version, canonical contribution ID, resolved entry, and a content hash of the contribution directory.
- A run MUST pin the loaded Flow definition and every referenced Action definition/hash when it starts.
- Updating, disabling, or deleting a plugin affects only new runs.
- If HMR of an existing contribution fails, Aura SHOULD keep the last successful definition available with a reload warning.
- If no successful version exists, the contribution MUST be unavailable.
- Errors returned to clients MUST be sanitized. Full local diagnostics MAY name plugin IDs and local source locations but MUST NOT include environment contents, credentials, request authorization, or model-provider payloads.
- Closing Aura MUST stop discovery, dispose Loader registrations, cancel or drain owned work according to existing orchestration rules, and release plugin capability resources.

## 9. Public SDK

External plugins import only public contracts:

```js
import { defineAction } from "@aura/plugin-sdk/action";
import { defineFlow, z } from "@aura/plugin-sdk/flow";
```

`@aura/plugin-sdk` SHOULD be a small package with stable exports and declarations. It MAY adapt to internal orchestration APIs, but external plugins MUST NOT depend on those internals directly.

Plugin JavaScript SHOULD begin with `// @ts-check`. The SDK MUST provide `.d.ts` declarations that infer Action parameter/output values and Flow input/output values. The loaded module MUST have exactly one default Action or Flow definition. Importing a module MUST NOT start services, open sockets, mutate storage, or execute the contribution; side effects belong inside the declared execution function.

## 10. Action contract

Example:

```js
// @ts-check
import { defineAction } from "@aura/plugin-sdk/action";

export default defineAction({
  title: "Text statistics",
  description: "Count characters and words.",
  parameters: {
    text: { type: "string", required: true }
  },
  output: {
    schema: {
      type: "object",
      properties: {
        characters: { type: "number" },
        words: { type: "number" }
      },
      required: ["characters", "words"]
    },
    render: (_input, output) => [
      { type: "text", text: JSON.stringify(output) }
    ]
  },
  timeoutMs: 5000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    return {
      characters: input.text.length,
      words: input.text.trim() ? input.text.trim().split(/\s+/u).length : 0
    };
  }
});
```

Requirements:

- Parameters and output MUST use the SDK-supported DSH Tool schema contract.
- Input and output MUST be JSON-serializable and remain within Aura's configured persistence limit; the default is 256 KiB each.
- An Action MUST check or propagate `ctx.signal` for filesystem, network, model, subprocess, and wait operations.
- `timeoutMs` MUST be finite and within the host limit; the default is 30 seconds, capped at 10 minutes.
- `output.render` controls the DSH-visible result and MUST NOT disclose secret or host-private values.
- Action code MUST resolve its own assets relative to `ctx.directory`, not `process.cwd()`.
- The host MAY provide `cwd`, IDs, mode, and granted `ctx.aura` ports. Plugins MUST treat other context fields as unavailable.
- Action context MUST NOT expose `agent()`, `flow()`, or nested `action()` execution. Compose those operations in a Flow.

## 11. Flow contract

Example:

```js
// @ts-check
import { defineFlow, z } from "@aura/plugin-sdk/flow";

export default defineFlow({
  title: "Media report",
  description: "Inspect media and produce a report.",
  input: z.object({ path: z.string().min(1) }),
  output: z.object({ report: z.string() }),
  concurrency: 2,
  agentTimeoutMs: 180000,

  async run(ctx, input) {
    const info = await ctx.action({
      id: "inspect",
      label: "Inspect media",
      action: "melody.media-toolkit/image-info",
      input: { path: input.path }
    });

    const report = await ctx.agent({
      id: "report",
      label: "Write report",
      preset: "researcher-v1",
      actions: [],
      prompt: JSON.stringify(info.output)
    });

    return { report: report.output };
  }
});
```

Requirements:

- Flow input and output MUST be validated by SDK-exported Zod schemas and remain JSON-serializable.
- Flow code MAY use JavaScript conditions, loops, and `Promise.all`; the host's concurrency gate remains authoritative.
- Step IDs MUST be unique within one run and stable enough for diagnostics.
- Cross-plugin Action references MUST use canonical IDs.
- Agent Actions MUST be explicitly listed. The default is no plugin Actions.
- Flow code MUST propagate cancellation and MUST NOT replay irreversible side effects automatically.
- A Flow MAY use granted Aura capability ports directly when the operation is orchestration-level rather than an Action. Reusable side effects SHOULD be modeled as Actions.

## 12. Aura capability gateway

Plugins call Aura through an SDK-defined `ctx.aura` object, never by importing implementation packages. Built-in capabilities are deny-by-default and granted by the manifest `permissions` array.

Initial capability namespaces MAY include:

| Capability | Intended responsibility |
| --- | --- |
| `aura.kv.read` / `aura.kv.write` | Plugin-namespaced durable JSON state. |
| `aura.artifacts.read` / `aura.artifacts.write` | Managed files and generated artifacts through opaque IDs. |
| `aura.workspace.read` | Read-only workspace metadata/content through bounded APIs. |
| `aura.local-ai.use` | Host-managed local model services without process ownership leakage. |
| `aura.events.emit` | Sanitized operational events owned by the plugin namespace. |

Rules:

- The manifest `permissions` lists required built-in capabilities. Activation MUST fail clearly when one is unsupported or not granted.
- The host MUST expose narrow versioned interfaces, not a generic service locator, raw Cordis context, filesystem root, process handle, or credential store.
- Durable storage keys and artifacts MUST be namespaced by plugin ID.
- Capability calls MUST accept cancellation where work can block and MUST apply host limits.
- Capability results crossing a future process boundary SHOULD remain structured-clone/JSON compatible.
- Model/provider operations MUST be mediated by Aura/DSH. Plugins MUST receive results, not provider tokens.
- Adding a capability requires backend documentation and focused contract tests; it does not authorize frontend changes.

## 13. Invocation rules

Supported call graph:

```text
Aura backend ──> Flow
Aura backend ──> Action
Flow ──────────> Action
Flow ──────────> DSH Agent ──> explicitly granted Action
Flow/Action ───> built-in capability granted by `permissions`
Action ────────> own plugin backend services (`ctx.services`)
Plugin page ───> own plugin backend `pageOperations`
```

Unsupported call graph:

```text
Action ─X─> Action
Action ─X─> Flow
Action ─X─> Agent
Plugin page ─X─> another plugin's backend
Plugin ─X─> frontend implementation
Plugin ─X─> Aura credentials or pi-ai client
```

These restrictions avoid recursive admission, concurrency deadlocks, hidden retries, ambiguous cancellation ownership, and dependency cycles. A future queued-job API may add nested orchestration only with depth, cycle, budget, idempotency, and ownership rules.

## 14. Persistence and compatibility

- Persist canonical plugin/contribution ID, plugin version, definition content hash, and existing run/step IDs.
- Historical records MUST remain readable when a plugin is disabled or removed.
- A plugin update MUST NOT reinterpret an in-flight run with new code.
- Manifest, SDK, DTO, and capability versions MUST be explicit. Breaking SDK changes require a new major version.
- Renaming a plugin or contribution creates a new canonical identity. Aliases or migrations require explicit host support and MUST NOT be inferred from matching titles.
- Plugin state migrations are not executable manifest fields. They require an explicit, separately authorized backend operation.

## 15. Backend package placement

When implementing this contract in Aura:

- Put manifest types that are truly runtime-neutral in a shared package only if both frontend and backend need them; otherwise keep them in backend code.
- Put public Action/Flow author contracts in a backend library such as `packages/backend/plugin-sdk`.
- Put configuration, manifest discovery, trust decisions, multi-root aggregation, and lifecycle management in a backend library such as `packages/backend/plugin-manager`.
- Keep Action/Flow execution and DSH/Cordis integration in `packages/backend/orchestration`.
- Keep final construction and configuration wiring in `packages/backend/runtime`.
- Do not make frontend libraries depend on plugin-host or orchestration packages.
- Preserve explicit workspace exports and dependency direction required by Aura's `AGENTS.md`.

Names are recommendations; prefer existing package seams when they already provide the same stable responsibility.

## 16. Validation checklist

### Plugin package

- Manifest schema and engine ranges validate.
- Plugin and local contribution IDs follow the naming rules.
- `package.json` declares ESM.
- Each declared root stays inside the plugin directory.
- Every contribution has one exactly named entry.
- Entry imports are side-effect free until execution.
- `// @ts-check` or an equivalent author check passes.
- Action inputs/outputs and Flow inputs/outputs pass their schemas.
- Cancellation reaches blocking operations.
- No secret, credential, raw provider client, frontend, or private Aura import is present.
- All cross-plugin references use canonical IDs.

### Aura host changes

- Built-in contributions still load when no external plugin configuration exists.
- Multiple roots load deterministically without ID collisions.
- Invalid manifests, missing dependencies, and unsupported engine ranges become sanitized unavailable states.
- Add, remove, disable, enable, successful HMR, and failed-HMR rollback are tested.
- Runs pin plugin versions and definition hashes.
- Capability denial, namespacing, cancellation, and size limits are tested.
- Shutdown removes watchers/registrations and releases owned resources.
- No frontend package or application change is introduced solely for plugin registration.
- Focused package tests pass, followed by the repository checks required by `AGENTS.md`.

## 17. Definition of done

An external plugin is complete when an explicitly configured local directory is validated at Aura startup, its JavaScript Actions/Flows and backend register through public SDK contracts, its Flow appears through the existing catalog without a frontend rebuild, its calls use only allowed invocation paths and granted permissions, failures are isolated and sanitized, updates affect only new runs, shutdown closes its backend cleanly, and the required tests/documentation pass.

## Product backend extension

[Backend extensions](backends.md) add backend-owned business services, scoped RPC,
Hono HTTP adapters, DSH presets and explicit durable relocation grants. Ordinary
Action/Flow plugins keep their IDs, implicit Flow scope and contracts.
