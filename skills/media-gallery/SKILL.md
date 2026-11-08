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
- Since plugin 0.2.0 every response (including 401/403) carries CORS headers, so
  widget errors show a real `HTTP <status>` instead of an opaque `Failed to fetch`.

## Setup steps

1. **Pick the public base URL** (`BASE`): the ClawFileServer URL as the *viewer's
   browser* reaches it. No trailing slash.
   - Direct: `http://<gateway-host>:<port><basePath>` (e.g. `http://gw.local:18789/clawfileserver`).
   - Behind a reverse proxy: use the proxy URL exactly as typed in a browser.
     If the proxy rewrite already inserts the basePath (e.g.
     `^/(.*)$ → /clawfileserver/$1`), do **not** repeat the prefix in BASE —
     a doubled prefix returns 403 (`outside configured roots`).
   - The viewer's device must resolve and reach BASE (public DNS, VPN, or split
     DNS — whatever fits where the dashboard is opened from).
   - If the dashboard is served over HTTPS, BASE must be HTTPS too (mixed
     content is blocked silently as `Failed to fetch`).
2. **Create the share token** (≥12 chars): `openssl rand -hex 16`.
   Set it as a JSON string — unquoted values can parse as non-string and the
   schema rejects them:
   `openclaw config set plugins.entries.clawfileserver.config.auth.token '"<token>"'`
   Apply via plugin reload; if the reload stalls behind "retained work items"
   (keep-alive connections), restart the Gateway instead.
3. **Verify before building**: `curl -s "<BASE>/<media-dir>/?json=1&t=<token>"`
   must return JSON with `entries`, and the same URL without `&t=` must return
   401. Fix auth before touching the widget.
4. **Build the widget**: copy `widget-template.html` (next to this file) and
   replace the placeholders:
   - `__BASE__` — base URL from step 1
   - `__TOKEN__` — token from step 2
   - `__DIR__` — absolute path of the media directory as ClawFileServer sees it
     (must be under a configured root), no trailing slash; path segments are
     URL-encoded by the template
   - `__MAX__` — max cards (default 12)
   Keep the generated file out of git-tracked directories (it embeds the token).
5. **Pin it** with `show_widget`: `name="media-gallery"`, `pin=true`, `size="xl"`,
   `capabilities={"netOrigins":["<origin of BASE>"]}`, `widget_code=` the file
   contents verbatim. Confirm the result says capabilities were granted.
   Later updates: regenerate and re-pin by the same name.
6. **Confirm rendering**: open the dashboard tab. Thumbnails should appear within
   a second. If an error shows, its text now includes the HTTP status — match it
   against the pitfalls below.

## Token rotation

`openclaw config set ...auth.token '"<new>"'` (string-quoted), restart/reload,
rebuild the widget with the new token, re-pin. The old token stops working at
reload time.

## Security notes

- The token grants **read-only GET/HEAD to every configured root**, and it sits
  inside the widget HTML: anyone who can view the dashboard (or the generated
  file) can read those files. Treat dashboard viewers as read-trusted; if the
  token leaks, rotate (above).
- Keep ClawFileServer roots narrow; don't expose trees you wouldn't hand a
  read-only guest.

## Pitfalls (learned the hard way)

- `netOrigins` must exactly match the BASE origin (scheme + host [+ port]);
  otherwise the widget sandbox blocks the fetches.
- A VPN-only / LAN-only DNS name for BASE fails with a bare `Failed to fetch`
  when the viewer is off that network. Pick an origin that matches where the
  dashboard is actually viewed from.
- Keep thumbnails as fetch → blob → dataURL. The widget sandbox's CSP restricts
  `img-src`; a plain `<img src="https://…">` may render blank. Verify before changing.
- Android WebView silently ignores `target="_blank"` and `window.open`; the
  template falls back to an in-widget detail view with a copy-URL button
  (clipboard API + execCommand fallback). Keep that pattern.
- Previews showing 401 → token type mismatch (number vs string in config) or a
  stale widget; re-check step 2 and re-pin.
- 403 `outside configured roots` → doubled path prefix (see step 1) or the
  directory is outside the plugin's roots.
