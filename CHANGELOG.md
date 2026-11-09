# Changelog

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
