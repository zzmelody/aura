# @aura/plugin-sdk

Public authoring contracts for trusted local backend plugins. External plugins
import only `@aura/plugin-sdk/action`, `@aura/plugin-sdk/flow` and
`@aura/plugin-sdk/capability`. The package adapts those stable contracts to Aura
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
runs once when Aura activates the plugin and returns
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

Providers are not hot reloaded. Changing a provider, the plugin version or its
settings reopens it on the next plugin configuration apply.

## Flow progress

`scope.report(value)` stores a JSON value of at most 4 KiB on the root Run. The
last value wins. It is not a durable step, so replay may repeat it.

## Failures

Plugin Actions may throw `ActionFailure` for a bounded message that is safe to
persist and show in Workflow UI. Ordinary errors remain generic. Product-facing
messages must identify the failed stage and next action without credentials,
private paths, signed URLs, raw provider responses, or stack traces.
