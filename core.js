// ClawFileServer core — filesystem browse / preview / edit over HTTP.
// Framework-free: createClawFileServer(config) -> { handle(req, res, basePath) }.
// Designed to be mounted on the OpenClaw Gateway HTTP surface by index.js, but
// runs behind any plain node:http server (see test/harness.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8', '.conf': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8', '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8', '.cpp': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8', '.java': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8', '.env': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.wasm': 'application/wasm',
};
const TEXTY = new Set(['.html', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.conf', '.csv', '.sh', '.py', '.xml',
  '.ts', '.tsx', '.jsx', '.c', '.h', '.cpp', '.rs', '.go', '.rb', '.java', '.sql', '.env']);
const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const VIDEO = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv']);
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac']);

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}
const fmtTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

function eqSafe(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const CSS = `
:root{color-scheme:dark}
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:24px;max-width:1100px}
h1{font-size:16px;font-weight:600;margin:0 0 4px}
h1 a{color:#e6edf3;text-decoration:none}
.crumb{color:#8b949e;margin-bottom:16px;font-size:13px;word-break:break-all}
.crumb a{color:#58a6ff;text-decoration:none}.crumb span{color:#8b949e}
table{border-collapse:collapse;width:100%}
th{text-align:left;color:#8b949e;font-weight:500;font-size:12px;border-bottom:1px solid #21262d;padding:4px 12px 4px 0}
td{border-bottom:1px solid #161b22;padding:3px 12px 3px 0;white-space:nowrap}
td.name{white-space:normal;word-break:break-all}
a{color:#58a6ff}a.d{color:#7ee787}
.sz,.mt{color:#8b949e;font-size:13px}
.thumb{height:38px;min-width:38px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:8px;background:#161b22}
pre{background:#161b22;padding:14px;border-radius:6px;overflow:auto;font-size:13px;max-height:80vh;white-space:pre-wrap;word-break:break-word}
.bar{margin:0 0 18px;font-size:13px;color:#8b949e}
.bar a{margin-right:14px}
.img{max-width:100%;border-radius:6px}
video{width:100%;max-height:80vh;border-radius:6px;background:#000}
audio{width:100%}
.upbar button,.upbar label{background:#21262d;border:1px solid #30363d;border-radius:6px;padding:4px 10px;cursor:pointer;color:#c9d1d9;margin-right:10px;font:inherit;display:inline-block}
.upbar button:hover,.upbar label:hover{border-color:#58a6ff}
#upst{color:#7ee787;font-size:13px}
.note{color:#8b949e;font-style:italic}
.badge{border:1px solid #30363d;border-radius:4px;padding:0 6px;font-size:11px;color:#8b949e}
textarea#ed{width:100%;height:78vh;box-sizing:border-box;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:12px;white-space:pre;resize:vertical;tab-size:2}
#sv{background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font:inherit;padding:4px 12px;cursor:pointer;margin-right:10px}
#st{margin-left:10px}
`;

export function createClawFileServer(cfg) {
  const roots = cfg.roots.map((r) => ({
    path: path.resolve(r.path),
    mode: r.mode === 'rw' ? 'rw' : 'ro',
    label: r.label || path.resolve(r.path),
  }));
  const maxPreview = cfg.maxPreviewBytes;
  const maxEdit = cfg.maxEditBytes;
  const maxList = cfg.maxListEntries;
  const auth = cfg.auth || { mode: 'none' };
  const log = cfg.logger || console;

  const inRoot = (p) => roots.some((r) => p === r.path || p.startsWith(r.path + '/'));
  const rootFor = (p) => roots.find((r) => p === r.path || p.startsWith(r.path + '/'));
  const inWritable = (p) => roots.some((r) => r.mode === 'rw' && (p === r.path || p.startsWith(r.path + '/')));

  const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

  function sendHTML(res, code, html) {
    const buf = Buffer.from(html);
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
    });
    res.end(buf);
  }
  function err(res, code, msg) {
    if (res.headersSent) return res.end();
    sendHTML(res, code, page(`${code}`, `<h1>${code}</h1><p class="note">${esc(msg)}</p><p><a href="./">back</a></p>`));
  }

  const encPath = (bp, p) => bp + '/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

  function crumbs(bp, p) {
    const root = rootFor(p);
    const rel = root && p.startsWith(root.path) ? p.slice(root.path.length) : p;
    const parts = rel.split('/').filter(Boolean);
    let acc = root ? root.path : '';
    const links = parts.map((seg) => {
      acc += '/' + seg;
      return `<a href="${esc(encPath(bp, acc))}">${esc(seg)}</a>`;
    });
    const home = root ? `<a href="${esc(encPath(bp, root.path))}">${esc(root.label)}</a>` : '<a href="./">roots</a>';
    return `<div class="crumb">${home}${links.map((l) => ' / ' + l).join('')}</div>`;
  }

  function rootsIndex(bp) {
    const rows = roots.map((r) =>
      `<tr><td class="name">📁 <a class="d" href="${esc(encPath(bp, r.path))}">${esc(r.label)}</a></td>` +
      `<td><span class="badge">${r.mode}</span></td><td class="mt">${esc(r.path)}</td></tr>`).join('\n');
    return page('ClawFileServer', `<h1>ClawFileServer</h1>
<div class="bar"><span class="note">configured roots</span></div>
<table><tr><th>name</th><th>mode</th><th>path</th></tr>${rows}</table>`);
  }

  function listing(res, bp, p) {
    let ents;
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      return err(res, e.code === 'EACCES' ? 403 : 500, `Cannot read directory: ${e.code}`);
    }
    if (!cfg.showHidden) ents = ents.filter((e) => !e.name.startsWith('.'));
    const rows = [];
    let truncated = false;
    if (ents.length > maxList) { ents = ents.slice(0, maxList); truncated = true; }
    const infos = ents.map((e) => {
      let st = null;
      try { st = fs.statSync(path.join(p, e.name)); } catch { /* dangling symlink etc */ }
      return { e, st };
    });
    infos.sort((a, b) => {
      const da = a.st ? a.st.isDirectory() : a.e.isDirectory();
      const db = b.st ? b.st.isDirectory() : b.e.isDirectory();
      if (da !== db) return da ? -1 : 1;
      return a.e.name.localeCompare(b.e.name, undefined, { numeric: true });
    });
    for (const { e, st } of infos) {
      const isDir = st ? st.isDirectory() : e.isDirectory();
      const href = encPath(bp, path.join(p, e.name)) + (isDir ? '/' : '');
      const size = st ? (st.isDirectory() ? '-' : fmtSize(st.size)) : '?';
      const mt = st ? fmtTime(st.mtimeMs) : '?';
      const thumb = !isDir && IMG.has(path.extname(e.name).toLowerCase())
        ? `<img class="thumb" loading="lazy" src="${esc(href)}?raw=1" alt="">` : '';
      rows.push(`<tr><td class="name">${thumb}<a class="${isDir ? '' : 'd'}" href="${esc(href)}">${esc(e.name)}</a></td>` +
        `<td class="sz">${size}</td><td class="mt">${mt}</td></tr>`);
    }
    const upUI = inWritable(p) ? `
<div class="bar upbar"><button onclick="newFolder()">+ New folder</button>
<label>⬆ Upload files<input id="upf" type="file" multiple hidden></label>
<span id="upst">drop files anywhere to upload</span></div>` : '';
    const upJS = inWritable(p) ? `<script>
const DIR=${JSON.stringify(p)};const BASE=${JSON.stringify(bp)};const st=document.getElementById('upst');
let done=0,total=0;
async function put(f){total++;st.textContent='uploading '+f.name+'\u2026';
 try{const r=await fetch(BASE+'/'+DIR.split('/').filter(Boolean).map(encodeURIComponent).join('/')+'/'+encodeURIComponent(f.name),{method:'PUT',body:f});
 st.textContent=(r.ok?'\u2713 ':'\u2717 ')+f.name;}catch{st.textContent='\u2717 '+f.name+' failed';}
 done++;if(done===total)setTimeout(()=>location.reload(),700);}
async function newFolder(){const n=prompt('Folder name:');if(!n)return;
 try{const r=await fetch(BASE+'/_mkdir?path='+encodeURIComponent(DIR+'/'+n),{method:'POST'});
 st.textContent=r.ok?'\u2713 folder created':'\u2717 folder failed';if(r.ok)setTimeout(()=>location.reload(),400);}catch{st.textContent='\u2717 failed';}}
document.getElementById('upf').addEventListener('change',e=>{[...e.target.files].forEach(put)});
addEventListener('dragover',e=>e.preventDefault());
addEventListener('drop',e=>{e.preventDefault();[...e.dataTransfer.files].forEach(put)});
</script>` : '';
    const body = `
<h1><a href="${esc(bp)}/">ClawFileServer</a></h1>
${crumbs(bp, p)}
${upUI}
<table><tr><th>name</th><th>size</th><th>modified</th></tr>
${rootFor(p) && p !== rootFor(p).path ? `<tr><td class="name"><a href="${esc(encPath(bp, path.dirname(p)))}/">..</a></td><td></td><td></td></tr>` : ''}
${rows.join('\n')}
</table>
${truncated ? '<p class="note">listing truncated at ' + maxList + ' entries</p>' : ''}
${upJS}`;
    sendHTML(res, 200, page(p + '/', body));
  }

  function editor(res, bp, p, st, text) {
    const fname = path.basename(p);
    const body = `<h1>${esc(fname)} <span class="note">editing</span></h1>${crumbs(bp, p)}
<div class="bar"><button id="sv">\u270e save (ctrl-s)</button>
<a href="${esc(encPath(bp, p))}">cancel</a> <span class="sz">${fmtSize(st.size)} \u00b7 ${fmtTime(st.mtimeMs)}</span>
<span id="st"></span></div>
<textarea id="ed" spellcheck="false">${esc(text)}</textarea>
<script>
const URL_=${JSON.stringify(encPath(bp, p))},MT=${JSON.stringify(String(Math.round(st.mtimeMs)))};
const ed=document.getElementById('ed'),stt=document.getElementById('st');
let dirty=false,saved=false;
ed.addEventListener('input',()=>{dirty=true});
addEventListener('beforeunload',(e)=>{if(dirty&&!saved){e.preventDefault();e.returnValue='';}});
async function save(){stt.textContent='saving\u2026';
 try{const r=await fetch(URL_,{method:'PUT',body:ed.value,headers:{'x-if-mtime':MT}});
  if(r.ok){saved=true;location.href=URL_;}
  else if(r.status===409){stt.textContent='\u26a0 file changed on server \u2014 reopen and re-apply';}
  else{stt.textContent='\u2717 refused: HTTP '+r.status;}}
 catch(e){stt.textContent='\u2717 '+e.message;}}
document.getElementById('sv').addEventListener('click',save);
addEventListener('keydown',(e)=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();save();}});
</script>`;
    sendHTML(res, 200, page(`${fname} — edit`, body));
  }

  function streamFile(req, res, p, st, asDownload) {
    const ext = path.extname(p).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'Access-Control-Allow-Origin': '*',
    };
    if (asDownload) {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(p).replace(/"/g, '')}"`;
    }
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - Number(m[2])); }
        else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1);
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function previewOrDownload(req, res, bp, p, st) {
    const ext = path.extname(p).toLowerCase();
    const url = req.url || '';
    const wantDl = /[?&]dl=1/.test(url);
    if (/[?&]raw=1/.test(url)) return streamFile(req, res, p, st, false);
    const fname = path.basename(p);
    if (!wantDl && TEXTY.has(ext) && st.size <= maxPreview) {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); }
      catch { text = '(binary or unreadable)'; }
      const editable = inWritable(p) && st.size <= maxEdit;
      if (editable && /[?&]edit=1/.test(url)) return editor(res, bp, p, st, text);
      const editLink = editable ? `<a href="${esc(encPath(bp, p))}?edit=1">edit</a> ` : '';
      const body = `<h1>${esc(fname)}</h1>${crumbs(bp, p)}
<div class="bar">${editLink}<a href="${esc(encPath(bp, p))}?dl=1">download</a> <span class="sz">${fmtSize(st.size)} \u00b7 ${fmtTime(st.mtimeMs)}</span></div>
<pre>${esc(text)}</pre>`;
      return sendHTML(res, 200, page(fname, body));
    }
    if (!wantDl && IMG.has(ext)) {
      const body = `<h1>${esc(fname)}</h1>${crumbs(bp, p)}
<div class="bar"><a href="${esc(encPath(bp, p))}?dl=1">download</a> <span class="sz">${fmtSize(st.size)} \u00b7 ${fmtTime(st.mtimeMs)}</span></div>
<img class="img" src="${esc(encPath(bp, p))}?raw=1">`;
      return sendHTML(res, 200, page(fname, body));
    }
    if (!wantDl && (VIDEO.has(ext) || AUDIO.has(ext))) {
      const tag = VIDEO.has(ext)
        ? `<video controls src="${esc(encPath(bp, p))}?raw=1"></video>`
        : `<audio controls src="${esc(encPath(bp, p))}?raw=1"></audio>`;
      const body = `<h1>${esc(fname)}</h1>${crumbs(bp, p)}
<div class="bar"><a href="${esc(encPath(bp, p))}?dl=1">download</a> <span class="sz">${fmtSize(st.size)} \u00b7 ${fmtTime(st.mtimeMs)}</span></div>
${tag}`;
      return sendHTML(res, 200, page(fname, body));
    }
    streamFile(req, res, p, st, wantDl);
  }

  function handlePut(req, res, p) {
    if (!inWritable(p)) return err(res, 403, 'that path is not under a read-write root');
    const inm = req.headers['x-if-mtime'];
    if (inm) {
      try {
        if (String(Math.round(fs.statSync(p).mtimeMs)) !== String(inm).trim()) {
          return err(res, 409, 'file changed on server since it was opened; reload and re-apply');
        }
      } catch { /* new file: no conflict possible */ }
    }
    try { if (fs.statSync(p).isDirectory()) return err(res, 409, 'that name is a directory'); } catch { /* new file */ }
    try { if (!fs.statSync(path.dirname(p)).isDirectory()) return err(res, 404, 'parent directory does not exist'); } catch { return err(res, 404, 'parent directory does not exist'); }
    const tmp = `${p}.upload-${process.pid}-${Date.now()}`;
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('error', () => { fs.unlink(tmp, () => {}); res.destroy(); });
    out.on('error', (e) => { fs.unlink(tmp, () => {}); err(res, 500, `write failed: ${e.code}`); });
    out.on('finish', () => {
      try { fs.renameSync(tmp, p); }
      catch (e) { fs.unlink(tmp, () => {}); return err(res, 500, `rename failed: ${e.code}`); }
      log.info?.(`clawfileserver upload ${p} (${fmtSize(size)})`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: p, size }));
    });
    req.pipe(out);
  }

  function handleMkdir(req, res, url) {
    let target;
    try { target = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') || ''); }
    catch { return err(res, 400, 'bad path'); }
    const rp = path.resolve('/' + target.replace(/^\/+/, ''));
    if (!inWritable(rp)) return err(res, 403, 'folder creation is limited to read-write roots');
    try { fs.mkdirSync(rp, { recursive: true }); }
    catch (e) { return err(res, 500, `mkdir failed: ${e.code}`); }
    log.info?.(`clawfileserver mkdir ${rp}`);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: rp }));
  }

  function basicAuthed(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    return i > -1 && eqSafe(raw.slice(0, i), auth.user) && eqSafe(raw.slice(i + 1), auth.password);
  }

  /**
   * Optional read-only share token: GET/HEAD requests carrying ?t=<token> or the
   * x-cfs-token header pass without basic auth. Never grants writes.
   */
  function tokenAuthed(req, qp) {
    if (!auth.token) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const q = qp.get('t');
    const h = req.headers['x-cfs-token'];
    return (typeof q === 'string' && q.length > 0 && eqSafe(q, auth.token))
      || (typeof h === 'string' && h.length > 0 && eqSafe(h, auth.token));
  }

  function jsonListing(res, p) {
    let ents;
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      const buf = Buffer.from(JSON.stringify({ error: e.code === 'EACCES' ? 'permission denied' : e.code }));
      return res.writeHead(e.code === 'EACCES' ? 403 : 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }), res.end(buf);
    }
    if (!cfg.showHidden) ents = ents.filter((e) => !e.name.startsWith('.'));
    const truncated = ents.length > maxList;
    if (truncated) ents = ents.slice(0, maxList);
    const entries = ents.map((e) => {
      let st = null;
      try { st = fs.statSync(path.join(p, e.name)); } catch { /* dangling */ }
      return {
        name: e.name,
        dir: st ? st.isDirectory() : e.isDirectory(),
        size: st && st.isFile() ? st.size : null,
        mtime: st ? Math.round(st.mtimeMs) : null,
      };
    });
    const buf = Buffer.from(JSON.stringify({ path: p, truncated, entries }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  }

  /**
   * Handle a request. basePath is the route prefix (no trailing slash).
   * Returns true when handled (always).
   */
  async function handle(req, res, basePath) {
    const bp = basePath.replace(/\/+$/, '');
    try {
      let raw = (req.url || '/');
      if (raw.startsWith(bp)) raw = raw.slice(bp.length) || '/';
      let query = '';
      const q = raw.indexOf('?');
      if (q >= 0) { query = raw.slice(q); raw = raw.slice(0, q); }
      if (auth.mode === 'basic' && !basicAuthed(req)) {
        const qp = new URLSearchParams(query);
        if (!tokenAuthed(req, qp)) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ClawFileServer"', 'Content-Type': 'text/plain' });
          res.end('ClawFileServer: login required');
          return true;
        }
      }
      let p;
      try { p = decodeURIComponent(raw); }
      catch { return err(res, 400, 'bad URL encoding'); }
      if (p.includes('\0')) return err(res, 400, 'bad path');
      if (!p.startsWith('/')) p = '/' + p;
      const url = p + query;
      req.url = url; // downstream helpers inspect query flags on req.url

      if (p === '/' || p === '') return sendHTML(res, 200, rootsIndex(bp));

      if (req.method === 'PUT') {
        const rp = path.resolve(p);
        if (!inRoot(rp)) return err(res, 403, 'outside configured roots');
        return handlePut(req, res, rp);
      }
      if (req.method === 'POST' && p === '/_mkdir') return handleMkdir(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return err(res, 405, 'GET/HEAD/PUT/POST(/_mkdir) only');
      }

      const rp = path.resolve(p);
      if (!inRoot(rp)) return err(res, 403, 'outside configured roots');
      let st;
      try {
        st = fs.statSync(rp);
      } catch (e) {
        if (e.code === 'ENOENT') return err(res, 404, `No such file or directory: ${rp}`);
        if (e.code === 'EACCES') return err(res, 403, `Permission denied: ${rp}`);
        return err(res, 500, `${e.code}: ${rp}`);
      }
      if (st.isDirectory()) {
        if (/[?&]json=1/.test(query)) return jsonListing(res, rp.replace(/\/+$/, '') || '/');
        return listing(res, bp, rp.replace(/\/+$/, '') || '/');
      }
      return previewOrDownload(req, res, bp, rp, st);
    } catch (e) {
      log.error?.(`clawfileserver error: ${e?.stack || e}`);
      err(res, 500, 'internal error');
      return true;
    }
  }

  return { handle, roots };
}
