---
name: clawfileserver-media-gallery
description: Build a self-refreshing image gallery dashboard widget backed by the ClawFileServer plugin. Trigger: asked for a media/photo gallery widget or dashboard gallery while clawfileserver is installed.
---

# ClawFileServer Media Gallery Widget

A Control UI dashboard widget that lists the newest images from a directory served
by ClawFileServer. It fetches the directory listing and thumbnails **live** over
HTTP with a read-only share token — no cron job, no base64 through the agent, and
it works whether or not the viewer's browser has the basic-auth login cached.

## How it works

- `GET <BASE>/<dir>/?json=1&t=<token>` → `{path, truncated, entries:[{name,dir,size,mtime}]}` (CORS `*`)
- `GET <BASE>/<file>?raw=1&t=<token>` → raw bytes (CORS `*`) — fetched as blob → dataURL for thumbnails
- `auth.token` (plugin config) lets GET/HEAD bypass basic auth. It is **read-only**:
  PUT/POST always require basic auth.

## Setup steps

1. **Pick the public base URL** (`BASE`): the ClawFileServer URL as the *viewer's
   browser* reaches it — e.g. `https://files.example.com` behind a reverse proxy
   that rewrites in the `/clawfileserver` prefix, or `http://gateway-host:18789/clawfileserver`
   direct. No trailing slash. If the proxy's rewrite already adds the plugin's
   basePath (e.g. `^/(.*)$ → /clawfileserver/$1`), do NOT repeat the prefix in
   BASE — a doubled prefix returns 403 (`outside configured roots`).
2. **Create the share token** (≥12 chars): `openssl rand -hex 16`.
   Set it as a JSON string — unquoted values can parse as non-string and the
   schema rejects them:
   `openclaw config set plugins.entries.clawfileserver.config.auth.token '"<token>"'`
   Apply via plugin reload; if the reload stalls behind "retained work items"
   (keep-alive connections), restart the Gateway instead.
3. **Verify**: `curl -s "<BASE>/<media-dir>/?json=1&t=<token>"` must return JSON
   with `entries`.
4. **Build the widget**: copy `widget-template.html` (next to this file) and
   replace the placeholders:
   - `__BASE__` — base URL from step 1
   - `__TOKEN__` — token from step 2
   - `__DIR__` — absolute path of the media directory as ClawFileServer sees it
     (must be under a configured root), e.g. `/home/user/.openclaw/workspace/media`
   - `__MAX__` — max cards (default 12)
5. **Pin it** with `show_widget`: `name="media-gallery"`, `pin=true`, `size="xl"`,
   `capabilities={"netOrigins":["<origin of BASE>"]}`, `widget_code=` the file
   contents verbatim. Later updates: regenerate and re-pin by the same name.

## Pitfalls (learned the hard way)

- `netOrigins` must exactly match the BASE origin (scheme + host [+ port]);
  otherwise the widget sandbox blocks the fetches.
- The viewer's device must be able to resolve and reach BASE. A LAN-only or
  VPN-only DNS name (no public A record) fails with a bare `Failed to fetch`
  off-network — pick an origin that matches where the dashboard is viewed from.
- Keep thumbnails as fetch → blob → dataURL. The widget sandbox's CSP restricts
  `img-src`; a plain `<img src="https://…">` may render blank. Verify before changing.
- Android WebView silently ignores `target="_blank"` and `window.open`; the
  template falls back to an in-widget detail view with a copy-URL button
  (clipboard API + execCommand fallback). Keep that pattern.
- The token grants read-only access to **every** configured root — generate the
  widget file outside git-tracked directories, or gitignore it.
- Previews showing 401 → token type mismatch (number vs string in config) or a
  stale widget; re-check step 2 and re-pin.
