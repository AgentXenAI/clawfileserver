# ClawFileServer

A web file browser for your [OpenClaw](https://github.com/openclaw/openclaw) Gateway: browse any configured directory tree, preview images / video / audio / text in the browser, and **edit text files in place** — all mounted on the Gateway's own HTTP port, no extra daemon or port to manage.

Born from a day-trip file server; packaged for everyone.

## Features

- **Directory browsing** with thumbnails, sizes, and timestamps
- **Previews**: images, video, audio, PDF, and syntax-neutral text views
- **Text editor** with Ctrl-S save and **conflict-safe writes** (an `x-if-mtime` guard refuses to clobber a file that changed on disk since you opened it — 409 instead of silent overwrite)
- **Uploads & folders**: drag-and-drop upload and new-folder creation on read-write roots
- **Range requests** for streaming media, `?dl=1` forced download, `?raw=1` raw bytes (with CORS, handy for embedding)
- **JSON listings**: `?json=1` on any directory returns `{entries:[{name,dir,size,mtime}]}` with CORS — machine-readable for widgets and scripts
- **Read-only share token**: set `auth.token` and GET/HEAD requests with `?t=<token>` (or `x-cfs-token` header) bypass basic auth — perfect for dashboard widgets and preview links. Writes always require basic auth, never the token.
- **Expiring share links**: `POST /_share?path=<abs>&ttl=24h&max=5` mints a `/s/<code>` capability URL (file or folder) with lifetime, optional download cap, and revoke — dead links answer `410 Gone`. Creation/list/revise always need basic auth; the read-only token is never enough.
- **Drop portals**: `POST /_drop?dir=<abs-rw>&ttl=12h&max=10` mints a `/d/<code>` upload page — drag-and-drop, streamed straight to disk (memory-safe, 2 GiB default per file), date-partitioned folders, collision-safe names. Perfect for receiving files from someone outside your network without giving them an account.
- **Bundled skill** `media-gallery`: teaches your agent to build a self-refreshing image-gallery dashboard widget on top of the JSON listing + share token (see `skills/media-gallery/`)
- **Root-scoped security**: only configured roots are reachable; read-only roots can't be written; everything outside returns 403
- **Optional basic auth** on the route (a password is generated and logged once if you enable `basic` without one)

## Install

```bash
openclaw plugins install clawhub:clawfileserver
```

Then configure and restart the Gateway.

## Configure

```jsonc
// openclaw.json → plugins.entries.clawfileserver.config
{
  "basePath": "/clawfileserver",
  "roots": [
    { "path": "/home/me/notes", "mode": "rw", "label": "Notes" },
    { "path": "/srv/books", "mode": "ro", "label": "Books" }
  ],
  "auth": { "mode": "basic", "user": "me", "password": "choose-one", "token": "optional-read-only-share-token" },
  "shares": { "defaultTtl": "24h", "maxTtl": "30d", "maxUploadBytes": 2147483648 }
}
```

With no config, ClawFileServer serves the **agent workspace** read-write at `http://<gateway>/clawfileserver/`.

### Share links & drop portals

```bash
# mint a 24h link for one file (max 5 downloads)
curl -u me:pass -X POST "$BASE/_share?path=/srv/books/guide.pdf&ttl=24h&max=5"
# → {"code":"...","url":"/clawfileserver/s/<code>","expires":"..."}

# mint a 12h upload portal into a read-write dir
curl -u me:pass -X POST "$BASE/_drop?dir=/home/me/inbox&ttl=12h&max=10"
# → send the /d/<code> URL to your friend; they drag files onto the page

# list everything with live status (active/expired/exhausted/revoked)
curl -u me:pass "$BASE/_shares"
# revoke now
curl -u me:pass -X POST "$BASE/_revoke?code=<code>"
```

Records persist in `shares.stateFile` (default `<state-dir>/clawfileserver/shares.json`); entries dead for 7+ days are pruned on startup.

## Security notes — read me

- The route is mounted on the **Gateway HTTP port**. With `auth.mode: "none"` (the default) anyone who can reach that port can browse your configured roots. That is fine when the Gateway is loopback-only or behind your own access-controlled TLS proxy; otherwise set `auth.mode: "basic"`.
- `openclaw doctor` flags `auth.mode: "none"` as a dangerous flag on purpose.
- Keep roots narrow. Don't expose `/`. Read-only (`"mode": "ro"`) is the right default for most trees; `rw` enables upload/mkdir/edit for that root.
- Editing is limited to text files under `maxEditBytes` (512 KiB default).
- The share token (`auth.token`) grants **read-only GET/HEAD** to every configured root — treat it like a low-privilege credential: generate it randomly (`openssl rand -hex 16`), rotate by resetting config, and don't commit generated widgets that embed it. Requests without a valid token still require basic auth.
- Share links (`/s/…`) and drop portals (`/d/…`) are **capability URLs**: the unguessable 10-char code *is* the credential, reachable even when basic auth is on. That's the point (hand one to someone outside your network) — but it means a leaked link works until it expires or you revoke it. Prefer short `ttl` values and `max` caps; check `/_shares` periodically.

## Media gallery widget

The bundled `media-gallery` skill teaches an OpenClaw agent to set up a live, self-refreshing gallery widget (listing + thumbnails fetched over HTTP, no cron). Ask your agent: *"set up the media gallery widget for `<some-dir>`"*.

## Development

```bash
npm test        # standalone harness: spins up the handler on localhost and exercises every route
```

The core (`core.js`) is framework-free — `createClawFileServer(config).handle(req, res, basePath)` — so it runs behind any `node:http` server; `index.js` is thin OpenClaw glue.

## License

MIT
