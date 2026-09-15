# @aura/extensions

Backend-only manager for explicitly enabled trusted local Aura plugins. It
reads `.aura/plugins.json`, validates package manifests and contribution roots,
checks engine and SDK compatibility, and returns sanitized status plus roots
for the orchestration host. Settings updates are serialized, applied to the
live host before an atomic config write, and rolled back if persistence fails.
It never installs dependencies or executes plugin code during discovery.
