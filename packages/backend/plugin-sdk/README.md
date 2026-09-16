# @aura/plugin-sdk

Public v1 authoring contracts for trusted local backend plugins. External
plugins import only `@aura/plugin-sdk/action` and `@aura/plugin-sdk/flow`.
The package adapts those stable contracts to Aura orchestration without
exposing runtime composition, credentials, DSH internals, or frontend code.

Plugin dependencies must be installed before Aura starts. Aura discovery is
read-only and never runs package-manager or lifecycle commands.

Plugins declare host-managed capabilities in `aura.plugin.json`. An Action
binds one with `auraCapability(ctx, capabilityId)` and invokes only its named
domain operations. Aura owns discovery, credentials, network access, and
cancellation; capability secrets never become Action parameters or outputs.
Aura 0.1 currently provides `aura.veya.world-agent`, a fixed-operation client
for Veya's authenticated loopback service.
