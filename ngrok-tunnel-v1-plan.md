# Ngrok Tunnel V1 Handoff (Server + CLI, UI Deferred)

## Purpose

This document is the reusable handoff/source-of-truth for ngrok tunnel support in OpenChamber V1.

V1 scope is tunnel-only and HTTP-oriented for OpenChamber upstreams, with ngrok-native connection types:

- `ephemeral`
- `reserved`
- `edge`

UI work is intentionally deferred.

## Current Implementation Status

Implemented in this branch:

- ngrok provider is registered in tunnel registry.
- ngrok modes are provider-native (`ephemeral|reserved|edge`) and work through API + CLI.
- CLI supports ngrok flags (`--connection-type`, `--reserved-domain`, `--edge-id`, `--endpoint-id`).
- Doctor/start/token behavior supports multiple token sources including config-check and env fallback.
- Docs updated in product docs and web README.

Still deferred:

- Settings UI integration for ngrok controls.
- Any TCP/TLS-first public protocol modeling in OpenChamber API/CLI.

## Files Changed / Owned

Core server:

- `packages/web/server/lib/tunnels/types.js`
- `packages/web/server/lib/tunnels/providers/ngrok.js`
- `packages/web/server/lib/ngrok-tunnel.js`
- `packages/web/server/index.js`

CLI:

- `packages/web/bin/cli.js`

Docs:

- `packages/docs/content/docs/tunnels.mdx`
- `packages/web/README.md`

## Contract Summary (Ngrok)

Normalized tunnel request fields used by server/provider:

- `provider: "ngrok"`
- `mode` (alias: `connectionType`) => `ephemeral | reserved | edge`
- `token` (alias: `authToken`)
- `reservedDomain` for `reserved`
- `edgeId` for `edge`
- `endpointId` for selecting an endpoint entry from ngrok config

Validation behavior:

- unsupported provider => `provider_unsupported`
- unsupported mode for provider => `mode_unsupported`
- missing required fields => `validation_error`
- missing dependency/binary in provider checks => dependency fail in doctor

## Token Resolution Rules (Critical)

Token source precedence for ngrok (doctor + start):

1. Explicit request/CLI token (`--token`, `--token-file`, `--token-stdin`, or API `token`/`authToken`)
2. `NGROK_AUTHTOKEN`
3. token extracted from config file path discovered via `ngrok config check`

When `--config <ngrok.yml>` is provided, config-derived values are also used for mode inputs:

- `agent.authtoken`/`authtoken` -> token
- `endpoints[].url` -> reserved domain / edge URL
- `endpoints[].name` -> selector for `--endpoint-id`

Notes:

- `--token-file` is permissive and supports raw token content and YAML containing `authtoken`.
- Config parsing supports both v2/v3 style authtoken entries via line-based extraction.
- `ngrok config check` output is parsed to discover active config path.

## Doctor Behavior (Ngrok)

Doctor mode now checks:

- provider dependency (`ngrok` binary present)
- token availability via precedence above
- mode-specific required fields:
  - `reserved` requires explicit `reservedDomain` **or** config-resolved endpoint/domain
  - `edge` requires explicit `edgeId` **or** config-resolved endpoint/url

Doctor source messaging:

- explicit token input => `Ngrok auth token provided explicitly.`
- env token => `Ngrok auth token loaded from NGROK_AUTHTOKEN.`
- config token => `Ngrok auth token loaded from <config-path>.`

Doctor endpoint-selection behavior when `--config` is used:

- one endpoint in config => auto-selected
- multiple endpoints => requires `--endpoint-id <name>` (or matching explicit domain/edge), otherwise fail with actionable message

Expected ephemeral doctor result when token exists from any source:

- `auth_token` status => `pass`

## Start Behavior (Ngrok)

CLI start behavior:

- `--connection-type` maps to mode and has precedence for ngrok.
- If no explicit token and provider is ngrok, CLI tries `NGROK_AUTHTOKEN`.
- Provider start then resolves token again on server side with same precedence.
- For ngrok:
  - `reserved` accepts explicit `reservedDomain` or config-derived endpoint/domain
  - `edge` accepts explicit `edgeId` or config-derived endpoint/url
  - `--endpoint-id` selects endpoint name from ngrok config when multiple endpoints exist

Server-side startup:

- spawns ngrok process with HTTP tunnel args
- parses logs for public URL and readiness/fatal patterns
- returns controller with `stop()` and `getPublicUrl()`

## CLI Surface (Ngrok)

Supported flags:

- `--provider ngrok`
- `--connection-type ephemeral|reserved|edge`
- `--reserved-domain <domain>`
- `--edge-id <id>`
- `--endpoint-id <name>` (endpoint selector name when using ngrok config)
- token flags still supported (`--token`, `--token-file`, `--token-stdin`)
- `NGROK_AUTHTOKEN` supported when token flags omitted
- `--config <path>` can act as ngrok value source (token + endpoints)

## Known Operational Caveat

If CLI output appears stale after code changes, the command may be talking to an already-running older OpenChamber server process.

Symptom example:

- direct source-level checks show token pass
- `openchamber tunnel doctor` still reports token missing

Resolution:

- restart the active OpenChamber instance and retry.

## Verification Commands

Build/lint/typecheck:

- `bun run type-check`
- `bun run lint`
- `bun run build`

Manual ngrok checks:

- `openchamber tunnel providers`
- `openchamber tunnel doctor --provider ngrok --json`
- `openchamber tunnel start --provider ngrok --connection-type ephemeral --dry-run --json`
- `openchamber tunnel start --provider ngrok --connection-type reserved --reserved-domain <domain> --dry-run --json`
- `openchamber tunnel start --provider ngrok --connection-type edge --edge-id <id> --dry-run --json`
- `openchamber tunnel start --provider ngrok --connection-type reserved --config <path> --endpoint-id <name> --dry-run --json`

Env fallback checks:

- `NGROK_AUTHTOKEN=<token> openchamber tunnel doctor --provider ngrok --json`
- `NGROK_AUTHTOKEN=<token> openchamber tunnel start --provider ngrok --connection-type ephemeral --dry-run --json`

Config-check path sanity:

- `ngrok config check`

## Important Design Decisions

- ngrok is modeled natively; we do not map ngrok concepts to Cloudflare-managed mode semantics.
- API/CLI remain HTTP-upstream-focused for OpenChamber use case.
- policy-first validation is preserved across interactive/non-interactive/quiet/json CLI modes.

## Follow-up Backlog (Post V1)

- Add Settings UI support for ngrok provider + connection type specific fields.
- Improve robustness of config path parsing if ngrok output format changes significantly.
- Consider explicit diagnostics field for token source (`request|env|config`) in doctor JSON response.
