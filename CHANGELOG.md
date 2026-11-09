# Changelog

## 0.4.0 — file operations
- Delete + rename/move endpoints and per-row UI buttons (read-write roots only, confirm dialog, root-self refused)
- `?zip=1` streamed folder download (deflate, data-descriptor entries, symlink-safe, `maxZipEntries` cap)
- `/_search` recursive search: name substring or `*glob*`, optional `content=1` body grep, JSON or `html=1` page; search box in every listing
- Markdown rendered preview with raw toggle (self-contained, no external JS)
- Harness: 87 checks (was 61)
