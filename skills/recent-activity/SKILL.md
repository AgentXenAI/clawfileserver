# Recent Activity Widget — Builder Skill

Builds a self-refreshing "what changed when" dashboard widget for the OpenClaw Control UI, backed by ClawFileServer's `/_recent` endpoint.

## Inputs

Ask the user (or infer):

- **hours** — default time window (1 / 6 / 24 / 72 / 168; default 24). The widget has a window picker; this just sets the initial value baked into the template.
- **root** — optional root name to pin (default: all roots, with a picker).
- **token** — ClawFileServer share token from `plugins.entries.clawfileserver.config.auth.token` (main session only; never echo it). If the user prefers no token, build without one (browser basic-auth prompt applies to row links).

## Build

1. Read the template `widget-template.html` from this skill directory.
2. Replace placeholders:
   - `__BASE__` → `auto` (recommended: resolves the gateway origin at runtime from `openclaw.host.controlUiBaseUrl`, works through any proxy/domain) or an explicit `http://127.0.0.1:18789`.
   - `__TOKEN__` → the share token, or empty string for no token.
   - `__BASEPATH__` → `clawfileserver` (or the configured route prefix).
3. Call `show_widget` with:
   - `title`: "Recent activity"
   - `layout`: `{w: 12, h: 9}`
   - `pin`: true
   - `name`: `recent-activity`
   - `html`: the filled template

The widget auto-refreshes every 60 s, has window + root pickers, stat chips (files / folders / total bytes touched), and each row links to the file through CFS (inline preview for media, download for the rest).

## Notes

- The widget sandbox has no same-origin access, so `__BASE__=auto` is what makes it work when the Control UI is served through a reverse proxy (any custom hostname). Verify the result renders from the requesting viewer's perspective; a successful `show_widget` status alone is not rendering proof.
- `/_recent` scans mtimes across roots; on very large trees keep `hours` small (the scan is capped by `searchScanLimit`).
- Rebuild and re-pin with the same `name` to update; do not create duplicate tabs.
