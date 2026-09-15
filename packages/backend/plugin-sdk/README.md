# @aura/plugin-sdk

Public v1 authoring contracts for trusted local backend plugins. External
plugins import only `@aura/plugin-sdk/action` and `@aura/plugin-sdk/flow`.
The package adapts those stable contracts to Aura orchestration without
exposing runtime composition, credentials, DSH internals, or frontend code.

Plugin dependencies must be installed before Aura starts. Aura discovery is
read-only and never runs package-manager or lifecycle commands.
