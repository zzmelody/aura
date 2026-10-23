# @aura/plugin-sdk

Public authoring contracts for trusted local backend plugins. External plugins
use its explicit public `action`, `flow`, `capability`, `backend`, `storage`,
`media`, `browser` and `errors` exports. The package adapts those stable contracts to Aura
orchestration without exposing runtime composition, credentials, DSH internals,
or frontend code.

Plugin dependencies must be installed before Aura starts. Aura discovery is
read-only and never runs package-manager or lifecycle commands.

## JavaScript authoring standard

Before writing or changing an external plugin Action, Flow, capability provider
or helper, read [the Airbnb-based JavaScript standard](../../../docs/plugin-javascript-code-style.md).
Keep native ESM and `// @ts-check`; the SDK's default-export entry contract takes
precedence over upstream module preferences. Plugins provide their own Prettier
and ESLint configuration. Format and lint changed files without modifying stable
IDs, schemas, durable steps or embedded source strings.

## Capabilities

An Action binds a capability with `auraCapability(ctx, capabilityId)` and
invokes only its named operations. There are two kinds:

- Built-in host capabilities (IDs without `/`, such as `aura.tripo.game-asset`)
  are listed in the manifest's `capabilities` array. Aura owns their
  credentials, network access and cancellation.
- Plugin providers live at `capabilities/<id>/<id>.capability.js` under the
  manifest's `contributes.capabilities` directory. Their ID is
  `<plugin-id>/<id>`, they are granted to that plugin's own Actions
  automatically, and no other plugin can reach them.

A provider default-exports `defineCapability({ title, open(host) })`. `open`
runs once for each activated provider revision and returns
`{ invoke(operation, input, call), runSettled?(run), close?() }`.

- `host.dataDir` is the plugin's private directory under
  `.aura/plugins/<plugin-id>/`.
- `host.settings` is the plugin entry's `settings` from `plugins.json`, passed
  through uninterpreted.
- `host.runs` reads only this plugin's Flow Runs.
- `host.invoke` calls built-in capabilities only.
- `call` carries `runId`, `rootRunId`, `stepId` and `idempotencyKey`, all
  supplied by the host.
- `runSettled` is called once per terminal root Run of the plugin, including
  Runs that ended while Aura was down.

Aura checks enabled provider sources and their static local ESM dependencies
every second. Code changes load a new native ESM revision, including helpers,
while published dependencies and the SDK remain shared. Automatic replacement
waits for active calls and the plugin's nonterminal Flow Runs. Failed candidates
leave the previous revision available. `open` should prepare resources without
starting business operations; replacement prepares the candidate before closing
the old providers. Durable state belongs in `host.dataDir`, not module globals.
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

## Product backends (1.4)

Providers own their business state and expose private services to their own
Actions through `ctx.services`. The host supplies scoped `host.workflows`,
leased `host.storage`, generic media/artifact primitives and workspace metadata.
No raw Cordis context, model client or credential service is exposed.

Optional provider `requests` dispatch only owned RPC prefixes; `chatTools` use
host-owned deduplication, quotas and run cards. Binary HTTP uses a prebuilt
`contributes.http` Hono adapter with declared mounts, scoped RPC and generic
artifacts. `contributes.presets` registers plugin-owned presets through DSH.

Historical names and IDs require explicit `compatibility` grants. A reviewed
old-to-new dependency hash mapping permits in-memory recovery of relocated
built-ins while preserving stored fingerprints; unknown/changed versions remain
refused. `defineWorkflow` preserves explicit durable root sequences;
`defineFlow` retains its original implicit plugin scope.
