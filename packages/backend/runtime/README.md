# @aura/runtime

Reusable backend runtime for Aura application entrypoints. It owns the local HTTP API, DSH process lifecycle, Codex authorization service, and the development-only DSH model. `apps/server` starts it as a standalone service; `apps/desktop` embeds it in the Electron main process.

The package consumes published DSH packages and an Aura-owned profile. It does not modify DSH or pi-ai source.
