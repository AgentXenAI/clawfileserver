# Changelog

## 0.4.14 — Xen self-audit hardening (2026-11-19)
Full manual read-through of core.js/config.js/index.js alongside ClawScan. Two real issues found that the scanner missed, plus one latent-pattern hardening.
- **Fix (Medium): share-token cookie leaked to every app on the host.** The `?t=` token promotion set `cfs_t` with `Path=/` and no expiry — on a multi-vhost host (e.g. `*.j87.io` behind one proxy) the bearer token was then sent to *every* hostname on that host, and persisted indefinitely. Cookie is now scoped to the plugin basePath, expires in 12h (`Max-Age=43200`), and carries `Secure` when the proxy reports an https client connection.
- **Fix (Low, DoS): PUT uploads had no size cap.** Drop portals enforce `maxUploadBytes`; plain PUT (the editor save path) accepted unbounded bodies — disk exhaustion by anyone who can reach a writable root. New `maxPutBytes` config (default 512 MiB) enforced both on `Content-Length` and mid-stream for chunked bodies.
- Hardening notes: `<title>` interpolation was already escaped (no change needed); markdown renderer, share-scope, symlink containment, and CSRF guards reviewed clean.
- Harness: 182 checks (was 178) — token cookie Path/Max-Age/HttpOnly assertions, chunked PUT past the cap refused 413, normal PUT still works.


## 0.4.13 — ClawScan 2026-11-20 audit fixes (stored XSS)
ClawHub's ClawScan of 0.4.12 confirmed the 0.4.11 findings (CWE-306 anonymous share admin, CWE-352 CSRF bypass) are gone, and surfaced one new real finding.
- **Fix (Medium, CWE-79): stored XSS via directory paths embedded in inline scripts.** Directory listings, the editor page, and drop portals interpolated paths/codes into `<script>` blocks with plain `JSON.stringify`, which does not escape `<` — a literal `</script>` inside a *path* terminates the script element during HTML parsing. Attack: an attacker with write access to a root creates a directory named `</script><script>…</script>`; a victim browsing *into* it executes the payload (same-origin, basic-auth context). All inline-script interpolations now go through a `jsJSON` serializer (`<` → `\u003c`, plus U+2028/2029 line terminators). The markdown preview's ad-hoc escape is folded into the same helper.
- Harness: 178 checks (was 174) — section 27 creates an evil-named directory and browses into it with raw `<>` in the URL; negative control confirms the old code fails the test and the fix passes.
- Not changed: ClawScan's High "default anonymous access" finding is the documented `auth.mode: "none"` default (fail-closed read-only since 0.4.7, flagged by `openclaw doctor` on purpose). Changing the default to require basic auth is a design decision reserved for the operator/maintainer.


## 0.4.12 — ClawScan 2026-11-19 audit fixes (share administration)
ClawHub's ClawScan scan of 0.4.11 completed with two Medium findings on the share-administration surface. Both were real; both are fixed here.
- **Fix (Medium, CWE-306): share administration is no longer anonymous when `auth.mode` is `"none"`.** The `/_share`, `/_shares`, `/_drop`, `/_revoke` endpoints only enforced basic auth *when basic mode was configured* — in the default `none` mode (where roots are already forced read-only) anonymous callers could mint, enumerate, and revoke share capabilities, contradicting the README. Share admin now requires basic authentication unconditionally: `if (auth.mode !== 'basic' || !basicAuthed(req)) → 403`. Operators who ran with `auth.mode: "none"` and had created shares anonymously should review and revoke those records (they remain in the state file) after upgrading.
- **Fix (Medium, CWE-352): the share-admin branch no longer bypasses the CSRF guard.** The 0.4.11 origin check ran *after* the share-admin early-return routing, so cross-origin form POSTs with cached basic credentials to `/_share`/`/_drop`/`/_revoke` skipped it. The origin check now runs *before* dispatch inside the share-admin branch. Additionally, when a reverse proxy sends `X-Forwarded-Proto`, the client-facing scheme must now match the `Origin` scheme (scheme-aware comparison per the audit recommendation).
- Harness: 174 checks (was 163) — anonymous share-admin refused in `none` mode (create/list/revoke/drop), cross-origin admin POSTs with valid credentials refused with no state change, same-origin admin still works, X-Forwarded-Proto scheme mismatch refused, read-only token cannot list shares. Share-admin test fixtures moved onto the basic-auth server so containment tests keep testing containment.

## 0.4.11 — ClawScan 2026-11-15 audit fixes
- **Fix (High, CWE-636): a failed `auth.password` SecretRef no longer downgrades to anonymous read-only.** Previously an unresolvable secret set `auth.mode='none'` (reads became public, only writes were protected). Now the plugin stays in basic mode with a poisoned credential: every request is refused 401 until the secret resolves, and no fallback password is generated. A failed token ref still just disables the optional token.
- **Fix (Medium, CWE-352): CSRF guard on mutations.** PUT and the `_mkdir`/`_delete`/`_move`/`_share` POSTs now require `Origin` to match `Host` when an `Origin` header is present (browsers always send one on cross-site posts), so a cross-origin form with cached basic credentials is refused 403. Origin-less API clients (curl, scripts) are unaffected; public drop uploads stay cross-origin by design.
- **Fix (Medium, CWE-1333): search globs can no longer blow up the event loop.** The glob→RegExp conversion (catastrophic backtracking on patterns like `*?*?*?...Z`) is replaced by a linear two-pointer matcher (O(n·m), no backtracking), with query length ≤128 and ≤16 wildcards as defense in depth. Glob semantics unchanged (full-match, `?` = one char).
- Harness: 163 checks (was 155) — poisoned-ref 401 tests, cross-origin/same-origin mutation tests, wildcard and length bounds, adversarial-glob timing.

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
