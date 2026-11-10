# ClawFileServer security audit — 2026-11-09

Source: ClawScan audit of `clawfileserver@0.4.4` published at
https://clawhub.ai/agentxenai/plugins/clawfileserver/security-audit
Verdict: **suspicious** (serious weaknesses, intent not established). Current released version: v0.4.6 (main = `3669ea7`).

## Findings (all rated High by ClawScan)

### 1. Unauthenticated read/write workspace access by default
- Location: `index.js` normalizeConfig (~L20): default root is `{mode:'rw'}`, default `auth = {mode:'none'}`.
- Not exploitable on the owner's deployment (basic auth + token configured), but the ClawHub default is fail-open.
- Fix: fail closed — refuse to serve (or force read-only + 401 on all mutations) when no auth configured; default roots read-only; share admin already requires basic (keep).

### 2. Symbolic-link traversal bypasses root & share boundaries
- Location: `core.js` `inRoot`/`rootFor`/`inWritable` (~L164–166) are lexical string checks; reads use `statSync` (follows links); `handlePut` (~L780–812) writes through unresolved paths; share dir handler (~L428–453) checks lexical containment then follows links.
- Attack: symlink inside a root pointing outside (e.g. `workspace/escape -> /etc`) passes `inRoot()`; writes can replace files outside roots; dir-share escape likewise.
- Fix: canonicalize with `fs.realpathSync` (existing portion for new files) and enforce containment on RESOLVED paths in ONE shared helper used by reads, writes, shares, drops, mkdir, move, delete, search, zip. Reject symlink components in write paths. Note: standalone realpath check has a check-to-use race vs concurrent link replacement — best-effort is fine here (single-operator box) but prefer `O_NOFOLLOW`/`fs.lstatSync` guards where cheap.

### 3. Stored XSS: HTML/SVG served from gateway origin
- Location: `core.js` MIME table (~L11–30) maps `.html/.htm/.svg` to active types; `streamFile` (~L317) sends them with no CSP/sandbox; `?raw=1` and share links stream them inline.
- Attack: attacker-placed HTML/SVG executes with the gateway origin (same origin as Control UI).
- Fix: for active content types (html, htm, svg, xhtml, xml?) on raw/share/listing-adjacent responses: `Content-Disposition: attachment` + `Content-Security-Policy: sandbox; default-src 'none'` + `X-Content-Type-Options: nosniff`. Keep previews for safe types. Apply consistently to raw, share, range, and fallback streaming paths.

## Remediation plan (target v0.4.7, develop on owner-redacted) — ✅ DONE 2026-11-09
Shipped as v0.4.7 (owner-redacted `19e4b48`, harness 131/131). Note from rollout: fix 1's
read-only default broke deployments relying on the implicit rw default — the owner's live
config now sets `roots: [{workspace, rw}]` explicitly; check for implicit-default
reliance before shipping fail-closed default changes.
1. Fail-closed auth default + read-only default root (index.js normalizeConfig).
2. Single `resolveContained()` realpath helper; swap every containment check to it (core.js).
3. Active-content headers in `streamFile` + share streaming path.
4. Harness regression tests per finding (unauth default refuses reads/writes; symlinked file/dir outside root → 403 for read/write/share/move; raw HTML gets attachment+sandbox headers).
5. Bump BOTH package.json and openclaw.plugin.json versions; deploy to owner-redacted; reload via background `owner-redacted N; openclaw plugins reload clawfileserver` (owner-redacted owner-redacted).
6. the owner tests → explicit approval → `owner-redacted release` (RELEASE GATE: never merge main without his OK).

## Notes
- the owner's deployment already has basic auth + share token; fixes are for ClawHub strangers + defense in depth.
- ClawHub registry search showed nothing for clawfileserver as of 16:02 — 0.4.4 submission may still be pending scans; consider publishing 0.4.7 once live.
- Harness currently 100 checks; keep all green.
