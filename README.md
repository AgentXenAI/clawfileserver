# ClawFileServer

A web file browser for your [OpenClaw](https://github.com/openclaw/openclaw) Gateway: browse any configured directory tree, preview images / video / audio / text in the browser, and **edit text files in place** — all mounted on the Gateway's own HTTP port, no extra daemon or port to manage.

Born from a day-trip file server; packaged for everyone.

## Features

- **Directory browsing** with thumbnails, sizes, and timestamps
- **Previews**: images, video, audio, PDF, and syntax-neutral text views
- **Text editor** with Ctrl-S save and **conflict-safe writes** (an `x-if-mtime` guard refuses to clobber a file that changed on disk since you opened it — 409 instead of silent overwrite)
- **Uploads & folders**: drag-and-drop upload and new-folder creation on read-write roots
- **Range requests** for streaming media, `?dl=1` forced download, `?raw=1` raw bytes (with CORS, handy for embedding)
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
  "auth": { "mode": "basic", "user": "me", "password": "choose-one" }
}
```

With no config, ClawFileServer serves the **agent workspace** read-write at `http://<gateway>/clawfileserver/`.

## Security notes — read me

- The route is mounted on the **Gateway HTTP port**. With `auth.mode: "none"` (the default) anyone who can reach that port can browse your configured roots. That is fine when the Gateway is loopback-only or behind your own access-controlled TLS proxy; otherwise set `auth.mode: "basic"`.
- `openclaw doctor` flags `auth.mode: "none"` as a dangerous flag on purpose.
- Keep roots narrow. Don't expose `/`. Read-only (`"mode": "ro"`) is the right default for most trees; `rw` enables upload/mkdir/edit for that root.
- Editing is limited to text files under `maxEditBytes` (512 KiB default).

## Development

```bash
npm test        # standalone harness: spins up the handler on localhost and exercises every route
```

The core (`core.js`) is framework-free — `createClawFileServer(config).handle(req, res, basePath)` — so it runs behind any `node:http` server; `index.js` is thin OpenClaw glue.

## License

MIT
