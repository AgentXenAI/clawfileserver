# Changelog

## 0.4.10 — SVG renders inline (sandboxed)
- **Change: `.svg` is served inline again.** The 0.4.7 blanket `Content-Disposition: attachment` on active content made SVG images undisplayable in browsers (forced download). SVG now renders inline while keeping `Content-Security-Policy: sandbox; default-src 'none'` + `nosniff` — under CSP sandbox (no `allow-scripts`) an SVG's scripts are inert and external fetches are blocked, which is the standard same-origin untrusted-SVG mitigation. HTML/XHTML remain forced-download + sandboxed (unchanged).
- Harness: 155 checks — SVG assertions flipped to inline+expected-headers; HTML/share/safe-type cases unchanged.

## 0.4.9 — SecretRef support in auth config
- **New: `auth.password` and `auth.token` now accept an OpenClaw SecretRef object** (`{source: "file"|"env", provider, id}`) in addition to a plain string, so credentials can live outside `openclaw.json` (`secrets audit` plaintext findings → zero). File refs resolve through `secrets.providers.<provider>` from the core config (json mode navigates `id` as `/key/path`); env refs read `process.env`.
- **Fail closed**: an unresolvable password ref drops the plugin out of basic auth (which forces every root read-only); an unresolvable token ref disables token access. Both log at error level with the reason.
- Harness: 155 checks (was 146) — 9 new SecretRef cases (file/nested/env/plain/failure paths).

## 0.4.8 — packaging + security (ClawScan review 2026-11-10)
- **Fix (critical, packaging): `config.js` was missing from the published 0.4.7 tarball** — `package.json` `files` omitted the newly extracted `config.js`, so ClawHub installs shipped a plugin whose entry-point import failed (could not load for anyone installing from ClawHub). `npm pack --dry-run` now lists all 8 files; packed artifact import smoke-tested.
- **Fix (High, XSS): markdown preview link rendering** — the embedded `md()` renderer interpolated link URLs into `href="..."` without escaping quotes, so `[x](https://e.com/"onmouseover="…)` executed inline handlers on the gateway origin. Anchors are now built via a replacer that escapes `"` → `&quot;`, strips control chars, and re-checks the `http(s):` allowlist. `javascript:`/`data:` were and remain never-linkified.
- **Fix (High, scope escape): share symlinks** — share paths were checked lexically against the share dir while realpath containment only guarded configured roots, so a symlink inside a shared dir pointing elsewhere *inside the same root* escaped the share scope. New `shareScopeErr()` gate on every share GET (listing + download): symlink components at/below the share path are refused and realpath containment is enforced against the share boundary itself; share listings `lstat` entries (no external size leak). File shares swapped to symlinks after creation are refused.
- Harness: 146 checks (was 131) — regression tests per finding, each verified to fail against the pre-fix code.

## 0.4.7 — security (ClawScan audit 2026-11-09)
- **Fail-closed defaults**: default root is now read-only; without `auth.mode="basic"` every root is forced read-only and all mutations (PUT/mkdir/delete/move/drop) are refused with 403. The share token remains read-only by design. Config normalization moved to `config.js` (unit-testable).
- **Symlink containment**: one `resolveContained()` realpath helper gates every path operation (reads, writes, shares, drops, mkdir, move, delete, search, zip, recent). A symlink component inside a root can no longer point outside it; write paths additionally refuse an existing symlink at the target.
- **Stored-XSS hardening**: active content (`.html .htm .svg .xhtml`) is always served with `Content-Disposition: attachment`, `Content-Security-Policy: sandbox; default-src 'none'`, and `X-Content-Type-Options: nosniff` on every streaming path (raw, share, range, fallback). SVG inline previews removed (downloads instead); HTML source preview stays (escaped text).
- Harness: 131 checks (was 100) — regression tests per audit finding.

## 0.4.5
- New: `GET /_recent?hours=24&max=100` activity feed (mtime walk across all roots, JSON) + bundled `recent-activity` dashboard widget skill (self-refreshing "what changed when" list)

## 0.4.4
- Fix: markdown preview rendered empty — a single-escaped \\n in the italic regex became a literal newline in the served script, breaking the whole inline <script>
- Removed the search box from listings (endpoint stays; UI parked pending proxy-prefix rework)

## 0.4.3
- Fix: share-token browsing broke on first click — links/forms/subresources dropped ?t=; the token is now promoted to a session cookie (cfs_t) and accepted from it

## 0.4.2
- Mobile layout: hide modified column under 720px, compact rename/delete buttons, zip badge no longer wraps, names break on word boundaries (no more one-char-per-line)

## 0.4.1
- Fix: zip general-purpose flags had the encryption bit set (0x0809 -> 0x0808); strict readers like Python zipfile refused the archives

## 0.4.0 — file operations
- Delete + rename/move endpoints and per-row UI buttons (read-write roots only, confirm dialog, root-self refused)
- `?zip=1` streamed folder download (deflate, data-descriptor entries, symlink-safe, `maxZipEntries` cap)
- `/_search` recursive search: name substring or `*glob*`, optional `content=1` body grep, JSON or `html=1` page; search box in every listing
- Markdown rendered preview with raw toggle (self-contained, no external JS)
- Harness: 87 checks (was 61)
