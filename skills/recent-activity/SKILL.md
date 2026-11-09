# Recent Activity widget

Builds a self-refreshing dashboard widget listing files modified across all
ClawFileServer roots within a time window (default 24h), newest first — the
"what changed when" feed. Backed by `GET /_recent?hours=&max=` (JSON).

## Build & pin

1. Ensure the share token file exists: `ops/recent-activity/.token` (same token
   as `ops/media-gallery/.token`).
2. `node ops/recent-activity/build.mjs` → writes `ops/recent-activity/widget.html`.
3. Pin with `show_widget`: name `recent-activity`, tab `gallery`, size `lg`,
   `widget_code` = exact file contents. Re-pin after rebuilds (pin-by-name
   updates in place).

## Template placeholders (build.mjs substitutes)

- `__BASE__` — `auto` (same-origin as Control UI, recommended) or an absolute
  origin like `https://owner-redacted` (its nginx rewrite prepends the basePath,
  so do NOT append it to BASE in that mode).
- `__BASEPATH__` — plugin mount path, default `clawfileserver`.
- `__TOKEN__` — read-only share token.
- `__HOURS__` — lookback window (default 24).
- `__MAX__` — max rows (default 60).

## Notes

- The widget sandbox has no same-origin access; `auto` mode resolves
  `openclaw.host.controlUiBaseUrl` a moment after init and retries until present.
- Rows link out to the CFS file page with the token attached.
- No cron: refresh is in-widget (60s) plus manual rebuilds when wanted.
