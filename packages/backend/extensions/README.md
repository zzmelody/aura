# @aura/extensions

Backend-only manager for explicitly enabled trusted local Aura plugins. It
reads `.aura/plugins.json`, validates package manifests and contribution roots,
checks engine and SDK compatibility, and returns sanitized status plus roots
for the orchestration host. Settings updates are serialized, applied to the
live host before an atomic config write, and rolled back if persistence fails.
It never installs dependencies or executes plugin code during discovery.

`index.ts` contains public exports only. `schemas.ts` owns manifest/configuration
validation, `configuration.ts` owns atomic persistence, `discovery.ts` owns
package/root validation, and `manager.ts` owns serialized activation and rollback.
Public types and the configuration error live in `types.ts`.

Validated contribution roots include an internal `pluginRoot` (the canonical
trusted package root). Runtime forwards it to discovery and registry; it never
enters catalog DTOs. External revision hashes include all contribution files and
the static local ESM import/re-export closure, including shared `lib/` modules.
Local specifiers must be literal relative paths and remain within that root.
Bare SDK/package imports continue to use installed dependency/version policy.
HMR watches the trusted plugin root so shared helper changes reload dependents.
Failed reload keeps the last good version. In-flight runs pin their loaded code;
a restart without that exact revision is rejected rather than silently replaying
new helpers. No code archive or dependency installation is introduced.
