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
- The widget renders in a sandbox on its own origin, so all URLs must be absolute.
  In the default mode the template builds them from `openclaw.host.controlUiBaseUrl`
  at runtime — i.e. **the same domain the dashboard itself is served from**.
- The template re-polls the listing **every 60 s** with a name+mtime signature
  check: no re-render when nothing changed, and a transient fetch failure never
  wipes the grid. Keep this polling when rebuilding — a widget that only fetches
  on page load goes stale and looks "frozen" (learned 2026-11-08).

## Feeding the gallery

The widget shows only images inside `__DIR__` (or symlinks pointing into other
allowed roots — symlinks are listed and served fine: JSON listing includes them,
`?raw=1` returns 200). Convention that keeps it useful:

- **Every image an agent generates or works on in chat gets at least a symlink in
  the gallery dir**, e.g. `ln -s ../projects/foo/assets/bar.png media/bar.png`.
  Keepsakes go in as real files; symlinks are the minimum for work-in-progress
  previews. (Owner rule, Jesse, 2026-11-08.)
- Name symlinks descriptively — the widget displays the link's filename, not the
  target's.

## Default setup: same domain as the Control UI (recommended)

No separate hostname needed. The gateway already serves ClawFileServer under
`/<basePath>` (default `/clawfileserver`) on the same port as the Control UI, so
any reverse proxy that forwards all paths to the gateway exposes it at
`https://<dashboard-domain>/clawfileserver/…` — links the widget presents then
look like `example.com/clawfileserver/…`.

1. **Verify the path routes**: `curl -s "<https://dashboard-domain>/clawfileserver/<media-dir>/?json=1&t=<token>"`
   must return JSON with `entries` (401 without `&t=`). If it 404s, the dashboard's
   reverse proxy does not forward that path to the gateway — add a location/route
   for `/clawfileserver/*` (or the configured `basePath`) before continuing.
2. **Create the share token** (≥12 chars): `openssl rand -hex 16`.
   Set it as a JSON string — unquoted values can parse as non-string and the
   schema rejects them:
   `openclaw config set plugins.entries.clawfileserver.config.auth.token '"<token>"'`
   Apply via plugin reload; if the reload stalls behind "retained work items"
   (keep-alive connections), restart the Gateway instead.
3. **Build the widget**: copy `widget-template.html` (next to this file) and
   replace the placeholders:
   - `__BASE__` — leave as `auto` for the default same-domain mode (recommended).
     Only set an explicit absolute URL (no trailing slash) for the separate-host
     variant below.
   - `__BASEPATH__` — the plugin `basePath` if non-default (default `clawfileserver`).
     Ignored when `__BASE__` is explicit.
   - `__TOKEN__` — token from step 2
   - `__DIR__` — absolute path of the media directory as ClawFileServer sees it
     (must be under a configured root), no trailing slash; path segments are
     URL-encoded by the template
   - `__MAX__` — max cards (default 12)
   Keep the generated file out of git-tracked directories (it embeds the token).
4. **Pin it** with `show_widget`: `name="media-gallery"`, `pin=true`, `size="xl"`,
   `capabilities={"netOrigins":["<origin of the dashboard domain>"]}` (e.g.
   `https://dashboard.example.com` — scheme + host [+ port], no path),
   `widget_code=` the file contents verbatim. Confirm the result says capabilities
   were granted. Later updates: regenerate and re-pin by the same name.
5. **Confirm rendering**: open the dashboard tab. Thumbnails should appear within
   a second. If an error shows, its text now includes the HTTP status — match it
   against the pitfalls below.

## Variant: separate hostname for the file server

Use when the file server must be reachable on its own origin (public share,
different cert, path not proxied):

- Set `__BASE__` to the URL as the *viewer's browser* reaches it. If a proxy
  rewrite already inserts the basePath (e.g. `^/(.*)$ → /clawfileserver/$1`), do
  **not** repeat the prefix in BASE — a doubled prefix returns 403
  (`outside configured roots`).
- `netOrigins` must list that separate origin instead.
- The viewer's device must resolve and reach it (public DNS, VPN, or split DNS).
- If the dashboard is served over HTTPS, BASE must be HTTPS too (mixed content
  is blocked silently as `Failed to fetch`).

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
- In same-domain mode the share links the widget presents are ordinary paths on
  the main domain (`example.com/clawfileserver/…`); they still require the token
  (or basic auth) — the domain being public does not make the files public.

## Pitfalls (learned the hard way)

- `netOrigins` must exactly match the origin the widget actually fetches (scheme +
  host [+ port]); otherwise the widget sandbox blocks the fetches. In `auto` mode
  that is the dashboard's own origin.
- `openclaw.host.controlUiBaseUrl` is null for a moment after init; the template
  polls it for ~10 s and then errors with "could not detect the Control UI
  origin". If you see that, the widget is not running inside the dashboard host
  (e.g. inline preview) — pin it, or set `__BASE__` explicitly.
- A VPN-only / LAN-only DNS name for the dashboard origin fails with a bare
  `Failed to fetch` when the viewer is off that network. Pick an origin that
  matches where the dashboard is actually viewed from.
- Keep thumbnails as fetch → blob → dataURL. The widget sandbox's CSP restricts
  `img-src`; a plain `<img src="https://…">` may render blank. Verify before changing.
- The widget sandbox never grants popups: script-initiated `window.open` fails
  everywhere, including web. On the web Control UI, a plain
  `<a target="_blank">` click is forwarded to the host and opens a real new tab
  — use that for links. The OpenClaw Android app's WebView silently ignores
  `target="_blank"`, so the template detects **WebView only** via the `"; wv)"`
  UA token (or an `OpenClaw` UA marker) and switches the detail view to the
  copy-URL fallback (clipboard API + execCommand). Never match bare `Android`:
  mobile browsers viewing the dashboard are web and must get real links
  (confirmed: OpenClaw Android app UA contains `; wv)`; Jesse verified both
  modes on web + app, 2026-11-08).
  Keep both modes; don't "simplify" the web links into the Android fallback.
- Previews showing 401 → token type mismatch (number vs string in config) or a
  stale widget; re-check step 2 and re-pin.
- 403 `outside configured roots` → doubled path prefix (see variant notes) or
  the directory is outside the plugin's roots.
- 404 on the listing URL in same-domain mode → the dashboard's reverse proxy
  doesn't route `/<basePath>/*` to the gateway (setup step 1).
