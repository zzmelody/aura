# Product backend extension (SDK 2.0)

Read this with the v2 specification and page extension. Product plugins own their
business libraries, collectors, HTTP adapters, Actions, Flows and presets. Host
packages supply generic workflow execution, model/credential mediation, storage
and plugin lifecycle. Do not add a permanent product-specific host facade.

## Backend ownership

A plugin has at most one backend: `contributes.backend` names one built ESM file
that default-exports `defineBackend({open(host)})` from `@aura/plugin-sdk/backend`.
In addition to page operations, the backend may return private `services`,
`requests`, `chatTools` and `artifactCandidates`. These objects never cross the
page JSON boundary. `services` binds only to this plugin's Actions as
`ctx.services`; Action definitions and running snapshots retain their backend
lease. Compose
work in Flows: Actions still cannot start Flows or nested Actions.

`host.storage.open(spec)` opens a generic schema-validated DSH domain. New names
start with `host.storage.namespace`; historical names need explicit
`compatibility.storageDomains` grants. Domain leases are serialized and reference
counted. Keep the original domain name, version, table names and record schemas
when relocating data. `host.storage.directory(name)` requires a corresponding
historical `compatibility.directories` grant. The returned path is backend-only.
`host.workspace.cwd`, `host.media` and the public `storage`, `media`, `browser`
and `errors` SDK modules contain generic filesystem, artifact and media
primitives, never a raw Cordis context, model client or credential service.

`host.workflows.start/get/runs.entries` is restricted to this plugin's namespace
and explicitly relocated Flow IDs. `host.runs` remains the read-only view.
Backends use this port to attach their own business services to the existing
durable engine. Model execution stays in host-managed Actions/DSH Agents.

`requests: {prefixes, handle}` handles plugin-namespaced RPC methods; historical
prefixes require `compatibility.rpcPrefixes`. Page calls still use only declared
`pageOperations`, bounded to 4 MiB. Never expose private services or file
descriptors through a general page dispatcher. `chatTools` contribute schemas
and a `start(input, {requestId, mode, signal})` callback. The host owns deduplication,
turn limits, run cards and settled waits; tools disappear when their plugin is
disabled. `artifactCandidates` adapts historical structured output into file
candidates; the host still verifies canonical paths and file content.

Automatic backend replacement waits for active calls, direct Actions and
nonterminal owned Runs. Disabling removes new contributions immediately, while
old snapshots retain their services. Replacing/re-enabling a busy backend is
refused until retained work settles; state is never force-closed underneath it.

## Binary HTTP and presets

```json
{
  "contributes": {
    "backend": "./backend/dist/index.js",
    "http": {
      "entry": "./backend/dist/http.js",
      "mounts": ["/flows/example-documents"]
    },
    "presets": "./presets"
  }
}
```

The HTTP entry is a prebuilt native ESM default factory receiving `PluginHttpHost`
from `@aura/plugin-sdk/backend`. Return `{fetch(request), close?()}` and implement
HTTP with Hono. It runs in the API process so uploads and Range streams do not
enter bounded JSON RPC. Only declared mounts and owned RPC prefixes are
reachable; overlapping mounts are rejected. Include body limits and error
projections in the plugin. Backend storage/credentials remain in the backend
child process; the HTTP adapter receives only generic artifacts and scoped RPC.

Preset directories contain `preset.yml` and `agent.cordis.yml`. The host registers
them with DSH, namespaced by default. `compatibility.presets` explicitly preserves
old IDs. Disabling unregisters new selection while DSH retains live Agent
revisions. Neither HTTP nor presets activate without `contributes.backend`.

Flow Agent calls reference a plugin preset as `<plugin-id>/<preset-directory>`,
for example a plugin preset such as `example-plugin/analyst`. Both Agent request validation and
persisted Agent steps accept this namespaced ID, including after host restart.
Existing unqualified preset IDs remain compatible; durable step IDs still use
their original unqualified format.

## Relocating durable definitions

Normal Action/Flow IDs remain `<plugin-id>/<local-id>`. An explicit
`compatibility.flows` / `compatibility.actions` entry retains the old unqualified
ID and provides `{from: [oldHash], to: reviewedNewHash}`. Capture old hashes before
moving entries. Freeze the new target after the reviewed build; builds must never
regenerate recovery grants. The registry exposes old hashes only while the
actual current dependency hash equals `to`. Recovery adapts the loaded definition
in memory for old records without plugin identity; stored IDs, hashes, Action
versions and step fingerprints are not rewritten. Changed code or unknown old
hashes still fail closed. Duplicate legacy owners are rejected.

Use SDK `defineWorkflow` when relocating an existing Flow with an explicit root
`sequence`. It preserves existing durable paths. The original SDK `defineFlow`
keeps its original implicit `plugin` scope; changing that behavior would break existing
plugins. Preserve all contribution IDs, schema fields, prompts and durable step
IDs. Completed history remains readable with the plugin disabled.

TypeScript authoring must compile to ESM before discovery. Package explicit
runtime files including backend bundles, generated entries and presets. Keep
runtime peer dependencies resolvable in release applications, and test a staged
plugin without its source directory. Never package user records, credentials,
browser profiles or caches. Startup does not install or build anything.
