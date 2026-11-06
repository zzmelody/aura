# @aura/plugin-sdk

Public authoring contracts for trusted local backend plugins. External plugins
use its explicit public `action`, `flow`, `backend`, `storage`,
`media`, `browser`, `metadata` and `errors` exports. The package adapts those stable contracts to Aura
orchestration without exposing runtime composition, credentials, DSH internals,
or frontend code.

Plugin dependencies must be installed before Aura starts. Aura discovery is
read-only and never runs package-manager or lifecycle commands.

## Version 2.5

The optional manifest `localization` field supplies static plugin names,
Action/Flow titles and descriptions, and JSON Schema display labels before any
page bundle loads. `@aura/plugin-sdk/metadata` exports `PluginLocalization`,
`SchemaTextKeys`, `ContributionTextKeys`, `MetadataCatalogs`, `metadataLocales`
and `isPluginLocalization` for authoring and validation. It has no UI dependency.

Declare `engines.pluginSdk: "^2.5.0"` when using the new manifest field. Existing
plugins without it keep their original display text and accepted `^2.0.0` ranges.
Plugins in the separate aura-studio repository can adopt it individually; no
IDs, schemas, prompts, saved configuration or historical records are migrated.
Page translations still use the independent `@aura/plugin-ui` contract.

See [static metadata](../../../docs/development/internationalization.md#插件静态元数据)
for the manifest shape, fallback behavior and display-only boundary.

## Version 2.2

`aura.process.manage` grants a backend access to `host.processes` for owned
Windows process trees and OS resource leases. `aura.codex.image` grants Actions
availability checks and image generation through the host's signed-in Codex
provider. The provider and credentials stay in Aura.

`actionRunSettled(runId)` lets an Action provider clean up work created for a
different plugin's Flow. The callback receives the Run ID and is scoped to
providers referenced by that Run's Action steps. The media SDK also exports
`mediaCommand` for cancellable FFmpeg operations.

The `local-media` plugin in aura-studio requires SDK 2.2. Existing `^2.0.0`
manifest ranges accept this version.

## Version 2.1

Aura loads plugin modules directly without hashing their source or static import
closure. Historical `FlowRun`, Action and step `sourceHash` fields are optional:
old records retain them, while new records omit them. Resume uses currently
loaded code and still enforces plugin identity, request fingerprints, model
configuration and step idempotency; completed effects and unknown requests are
not automatically repeated. Runtime load tokens only invalidate UI previews.

Plugins in the separate aura-studio repository that read `sourceHash` must treat
it as optional. Existing `^2.0.0` SDK engine ranges accept 2.1; no plugin IDs,
domain names, credentials or saved configuration are rewritten.

## JavaScript authoring standard

Before writing or changing an external plugin Action, Flow, backend or helper, read [the Airbnb-based JavaScript standard](../../../docs/plugin-javascript-code-style.md).
Keep native ESM and `// @ts-check`; the SDK's default-export entry contract takes
precedence over upstream module preferences. Plugins provide their own Prettier
and ESLint configuration. Format and lint changed files without modifying stable
IDs, schemas, durable steps or embedded source strings.

## Permissions

An Action binds a built-in host capability with
`auraCapability(ctx, capabilityId)` and invokes only its named operations.
Built-in IDs, such as `aura.codex.image`, are listed in the manifest's
`permissions` array. Aura owns their credentials, network access and
cancellation.

## Backend

A plugin has at most one backend. The manifest's `contributes.backend` names a
single built ESM file (for example `./backend/dist/index.js`) that
default-exports `defineBackend({ open(host) })` from `@aura/plugin-sdk/backend`.
`open` runs once for each activated backend revision and returns an object
whose members are all optional:

- `pageOperations` + `invoke(operation, input, call)`: the only entry this
  plugin's workbench pages can reach. Pages call `props.invoke(operation,
input, signal)`; operations not listed are refused before `invoke` runs.
- `services`: private objects bound to this plugin's Actions as `ctx.services`.
- `requests`, `chatTools`, `artifactCandidates`, `serves` + `admit`/`view`/
  `resume`, `runSettled(run)`, `close()`.

- `host.dataDir` is the plugin's private directory under
  `.aura/plugins/<plugin-id>/`.
- `host.tempDir` is the plugin's scratch directory under the runtime temp root
  (`<tempDir>/plugins/<plugin-id>/`, default `<root>/local/runtime`). It may be
  deleted at any time; put render intermediates there, never durable state.
- `host.settings` is the plugin entry's `settings` from `plugins.json`, passed
  through uninterpreted.
- `host.runs` reads only this plugin's Flow Runs.
- `host.invoke` calls built-in capabilities only.
- `call.signal` is the host-supplied cancellation of one page call.
- `runSettled` is called once per terminal root Run of the plugin, including
  Runs that ended while Aura was down.

Aura checks each enabled backend entry and its static local ESM dependencies
every second. Code changes load a new native ESM revision, including helpers,
while published dependencies and the SDK remain shared. Automatic replacement
waits for active calls and the plugin's nonterminal Flow Runs. Failed candidates
leave the previous revision available. `open` should prepare resources without
starting business operations; replacement prepares the candidate before closing
the old backend. Durable state belongs in `host.dataDir`, not module globals.
Plugin directory, version and settings changes still use the configuration API;
source hot reload never rewrites `plugins.json`.

## Flow progress

`scope.report(value)` stores a JSON value of at most 4 KiB on the root Run. The
last value wins. It is not a durable step, so replay may repeat it.

## Failures

Plugin Actions may throw `ActionFailure` for a bounded message that is safe to
persist and show in Workflow UI. Ordinary errors remain generic. Product-facing
messages must identify the failed stage and next action without credentials,
private paths, signed URLs, raw provider responses, or stack traces.

SDK 2.6 adds `new ActionFailure(message, { translations: { en, "zh-CN", ja,
ko, ru, fr }, cause? })`. English is required; missing locales fall back to
English. These are literal public messages, limited to 2,000 characters each.
They must not contain private diagnostics or input values. A private direct-call
callback retains display data outside the Error object and DSH tool result;
model-visible failures and durable records keep the original message.
Backends may throw `PluginFailure(message, translations, status?)` from
`@aura/plugin-sdk/errors` at page/admission boundaries. The host validates the
display payload and keeps the original message/status. Require SDK `^2.6.0`
when using these additions; older plugins and the independent aura-studio
repository can adopt them without changing IDs, schemas or stored data.

## Product backends

A backend owns its plugin's business state and exposes private services to its
own Actions through `ctx.services`. The host supplies scoped `host.workflows`,
leased `host.storage`, generic media/artifact primitives and workspace metadata.
No raw Cordis context, model client or credential service is exposed.

Optional backend `requests` dispatch only owned RPC prefixes; `chatTools` use
host-owned deduplication, quotas and run cards. Binary HTTP uses a prebuilt
`contributes.http` Hono adapter with declared mounts, scoped RPC and generic
artifacts. Declare a free top-level namespace such as `/example-documents` or
a Flow namespace such as `/flows/example-documents`. Both receive the original
request URL under the runtime's Origin policy. SDK 2.3 adds the optional
`localConfiguration` HTTP flag for loopback settings routes and the optional
`attachments.readImage` backend port for validated session attachments.
SDK 2.4 exposes `BackendHost.localConfiguration` to gate local settings page
operations. `contributes.presets` registers plugin-owned presets through DSH.

Historical names and IDs require explicit `compatibility` grants. A reviewed
old-to-new dependency hash mapping permits in-memory recovery of relocated
built-ins while preserving stored fingerprints; unknown/changed versions remain
refused. `defineWorkflow` preserves explicit durable root sequences;
`defineFlow` retains its original implicit plugin scope.

See the complete [backend contract](../../../.agents/skills/aura-plugin-development/references/backends.md).
