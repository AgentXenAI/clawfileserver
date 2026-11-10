// ClawFileServer core — filesystem browse / preview / edit over HTTP.
// Framework-free: createClawFileServer(config) -> { handle(req, res, basePath) }.
// Designed to be mounted on the OpenClaw Gateway HTTP surface by index.js, but
// runs behind any plain node:http server (see test/harness.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { finished } from 'node:stream/promises';

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
// SECURITY: active content — markup that a browser would execute if rendered as
// a document. Served files must NEVER run scripts on the gateway origin
// (stored XSS). streamFile() forces download + sandbox on every streaming path.
const ACTIVE = new Set(['.html', '.htm', '.svg', '.xhtml']);
const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
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

// Capability codes: unambiguous alphabet (no 0/O/1/l/i), 10 chars ≈ 59 bits.
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function genCode(len = 10) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length];
  return s;
}

/** "90m" | "24h" | "7d" | "45s" -> ms; NaN on garbage. */
function parseTtl(v, defMs) {
  if (v == null || v === '') return defMs;
  const m = /^(\d+)\s*([smhd])$/i.exec(String(v).trim());
  if (!m) return NaN;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
}

/** basename-only, control chars and leading dots stripped */
function safeName(n) {
  const s = String(n || '').replace(/\\/g, '/').split('/').pop()
    .replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return s || 'file';
}

const CSS = `
:root{color-scheme:dark}
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#071A33;color:#D8E6F3;margin:0;padding:24px;max-width:1100px;accent-color:#FF7A29}
.logo{height:30px;vertical-align:-8px;margin-right:6px}
h1{font-size:16px;font-weight:600;margin:0 0 4px}
h1 a{color:#FFC53D;text-decoration:none}
.crumb{color:#7FA8C9;margin-bottom:16px;font-size:13px;word-break:break-all}
.crumb a{color:#38BDF8;text-decoration:none}.crumb span{color:#7FA8C9}
table{border-collapse:collapse;width:100%}
th{text-align:left;color:#7FA8C9;font-weight:500;font-size:12px;border-bottom:1px solid #2A4E7C;padding:4px 12px 4px 0}
td{border-bottom:1px solid #16345A;padding:3px 12px 3px 0;white-space:nowrap}
td.name{white-space:normal;word-break:break-all}
a{color:#38BDF8}a:hover{color:#FF7A29}a.d{color:#FFC53D}
.sz,.mt{color:#7FA8C9;font-size:13px}
.thumb{height:38px;min-width:38px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:8px;background:#123055}
pre{background:#123055;padding:14px;border-radius:6px;overflow:auto;font-size:13px;max-height:80vh;white-space:pre-wrap;word-break:break-word}
.bar{margin:0 0 18px;font-size:13px;color:#7FA8C9}
.bar a{margin-right:14px}
.img{max-width:100%;border-radius:6px}
video{width:100%;max-height:80vh;border-radius:6px;background:#04101F}
audio{width:100%}
.upbar button,.upbar label{background:#16345A;border:1px solid #2A4E7C;border-radius:6px;padding:4px 10px;cursor:pointer;color:#D8E6F3;margin-right:10px;font:inherit;display:inline-block}
.upbar button:hover,.upbar label:hover{border-color:#38BDF8}
#upst{color:#FFC53D;font-size:13px}
.note{color:#7FA8C9;font-style:italic}
.badge{border:1px solid #2A4E7C;border-radius:4px;padding:0 6px;font-size:11px;color:#7FA8C9}
textarea#ed{width:100%;height:78vh;box-sizing:border-box;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#123055;color:#D8E6F3;border:1px solid #2A4E7C;border-radius:6px;padding:12px;white-space:pre;resize:vertical;tab-size:2}
#sv{background:#FF7A29;border:1px solid #E8651A;border-radius:6px;color:#0B2545;font:inherit;font-weight:600;padding:4px 12px;cursor:pointer;margin-right:10px}
#st{margin-left:10px}
footer{margin-top:28px;padding-top:12px;border-top:1px solid #2A4E7C;font-size:12px;color:#7FA8C9}
footer a{color:#38BDF8;text-decoration:none}footer a:hover{color:#FF7A29}
footer .crab{margin-right:4px}
button.mini{background:none;border:1px solid #2A4E7C;border-radius:4px;color:#7FA8C9;font:inherit;font-size:12px;padding:0 6px;cursor:pointer;margin-left:6px}
button.mini:hover{border-color:#FF7A29;color:#FF7A29}
td.act{white-space:nowrap}
form.srch{display:inline-flex;gap:6px;align-items:center;margin-top:10px}
form.srch input[type=text]{background:#123055;border:1px solid #2A4E7C;border-radius:6px;color:#D8E6F3;padding:3px 8px;font:inherit}
form.srch button{background:#16345A;border:1px solid #2A4E7C;border-radius:6px;color:#D8E6F3;padding:3px 10px;cursor:pointer;font:inherit}
form.srch button:hover{border-color:#38BDF8}
.mdv{background:#123055;border-radius:6px;padding:6px 20px;max-height:80vh;overflow:auto}
.mdv h1,.mdv h2,.mdv h3,.mdv h4,.mdv h5,.mdv h6{color:#FFC53D}
.mdv a{color:#38BDF8}.mdv a:hover{color:#FF7A29}
.mdv code{background:#0B2545;border-radius:3px;padding:1px 4px}
.mdv pre{background:#0B2545}
.mdv blockquote{border-left:3px solid #FF7A29;margin:8px 0;padding:2px 12px;color:#7FA8C9}
.zip{color:#7FA8C9;font-size:12px;border:1px solid #2A4E7C;border-radius:4px;padding:0 6px;text-decoration:none;margin-left:8px;white-space:nowrap;display:inline-block}
.zip:hover{border-color:#38BDF8;color:#38BDF8}
td.name{word-break:normal;overflow-wrap:anywhere}
@media (max-width:720px){
 body{padding:14px}
 th.mt,td.mt{display:none}
 td.name{font-size:13px}
 button.mini{padding:0 5px;font-size:11px;margin-left:4px}
 td.act{padding-right:0}
 td{padding:3px 8px 3px 0}
 th{padding:4px 8px 4px 0}
 .thumb{height:30px;min-width:30px;margin-right:6px}
}
`;

const here = path.dirname(new URL(import.meta.url).pathname);
const iconURI = (f) => {
  try { return 'data:image/png;base64,' + fs.readFileSync(path.join(here, 'assets', 'icons', f)).toString('base64'); } catch { return ''; }
};
const LOGO_URI = iconURI('cfs-crab-folder-transparent-64.png');
const FAVICON_URI = iconURI('cfs-crab-folder-transparent-32.png');
let VERSION = '0.3.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version || VERSION; } catch {}

export function createClawFileServer(cfg) {
  const roots = cfg.roots.map((r) => {
    const lexical = path.resolve(r.path);
    let real = lexical;
    try { real = fs.realpathSync(lexical); } catch { /* root may not exist yet; lexical fallback */ }
    return {
      path: lexical,
      real,
      mode: r.mode === 'rw' ? 'rw' : 'ro',
      label: r.label || lexical,
    };
  });
  const maxPreview = cfg.maxPreviewBytes;
  const maxEdit = cfg.maxEditBytes;
  const maxList = cfg.maxListEntries;
  const auth = cfg.auth || { mode: 'none' };
  const log = cfg.logger || console;

  const inRoot = (p) => roots.some((r) => p === r.path || p.startsWith(r.path + '/'));
  const rootFor = (p) => roots.find((r) => p === r.path || p.startsWith(r.path + '/'));
  const inWritable = (p) => roots.some((r) => r.mode === 'rw' && (p === r.path || p.startsWith(r.path + '/')));

  /**
   * SECURITY: real-path containment. Lexical checks (inRoot above) are bypassed
   * by symlink components inside a root (e.g. `workspace/escape -> /etc`).
   * resolveContained() canonicalizes the EXISTING portion of `p` with
   * realpathSync (walking up for not-yet-existing tails) and requires the
   * resolved path to stay under the REAL path of the root that lexically
   * contains it. With forWrite, an existing symlink at the final component is
   * also refused (writes must not follow links). Every containment gate —
   * reads, writes, shares, drops, mkdir, move, delete, search, zip, recent —
   * goes through this ONE helper. Best-effort vs a concurrent link swap
   * (check-to-use race); acceptable on a single-operator box.
   * Returns { real, root } or { err }.
   */
  function resolveContained(p, forWrite = false) {
    const root = rootFor(p);
    if (!root) return { err: 'outside configured roots' };
    let real;
    try {
      real = fs.realpathSync(p);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        // missing tail (new file/dir): canonicalize nearest existing ancestor
        let dir = p;
        const tail = [];
        for (;;) {
          try { real = fs.realpathSync(dir); break; }
          catch (e2) {
            if (e2.code !== 'ENOENT' && e2.code !== 'ENOTDIR') return { err: `cannot resolve path: ${e2.code}` };
            const up = path.dirname(dir);
            if (up === dir) return { err: 'cannot resolve path' };
            tail.unshift(path.basename(dir));
            dir = up;
          }
        }
        real = path.resolve(real, ...tail);
      } else {
        // ELOOP, EACCES, ...: cannot verify containment -> refuse
        return { err: `cannot resolve path: ${e.code}` };
      }
    }
    if (real !== root.real && !real.startsWith(root.real + path.sep)) {
      return { err: 'path escapes root via symlink' };
    }
    if (forWrite) {
      try { if (fs.lstatSync(p).isSymbolicLink()) return { err: 'symlink components are not allowed in write paths' }; }
      catch { /* new file: fine */ }
    }
    return { real, root };
  }

  /** Containment + read-write gate for mutating operations. */
  function writeGate(p) {
    const c = resolveContained(p, true);
    if (c.err) return c;
    if (c.root.mode !== 'rw') return { err: 'that path is not under a read-write root' };
    return c;
  }

  const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${FAVICON_URI ? `<link rel="icon" type="image/png" href="${FAVICON_URI}">` : ''}
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}
<footer><span class="crab">🦀</span> ClawFileServer v${esc(VERSION)} — crafted by <a href="https://github.com/AgentXenAI" rel="noopener">XenAI</a> · <a href="https://github.com/AgentXenAI/clawfileserver" rel="noopener">GitHub</a></footer></body></html>`;

  function sendHTML(res, code, html) {
    const buf = Buffer.from(html);
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
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
      const zipLink = isDir ? `<a class="zip" href="${esc(href)}?zip=1" title="download folder as zip">zip</a>` : '';
      const acts = inWritable(p) ? `<td class="act"><button class="mini" data-ren="${esc(e.name)}" title="rename / move">rename</button><button class="mini" data-del="${esc(e.name)}" data-dir="${isDir ? 1 : 0}" title="delete permanently">delete</button></td>` : '<td></td>';
      rows.push(`<tr><td class="name">${thumb}<a class="${isDir ? '' : 'd'}" href="${esc(href)}">${esc(e.name)}</a>${zipLink}</td>` +
        `<td class="sz">${size}</td><td class="mt">${mt}</td>${acts}</tr>`);
    }
    const upUI = inWritable(p) ? `
<div class="bar upbar"><button onclick="newFolder()">+ New folder</button>
<label>⬆ Upload files<input id="upf" type="file" multiple hidden></label>
<span id="upst">drop files anywhere to upload</span></div>` : '';
    const searchUI = '';
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
document.addEventListener('click',async(ev)=>{
 const rb=ev.target.closest&&ev.target.closest('[data-ren]'),db=ev.target.closest&&ev.target.closest('[data-del]');
 if(rb){ev.preventDefault();const n=rb.getAttribute('data-ren');const nn=prompt('New name:',n);
  if(!nn||nn===n)return;
  try{const r=await fetch(BASE+'/_move?from='+encodeURIComponent(DIR+'/'+n)+'&to='+encodeURIComponent(DIR+'/'+nn),{method:'POST'});
   st.textContent=r.ok?'\u2713 renamed':'\u2717 rename refused';if(r.ok)setTimeout(()=>location.reload(),400);}catch{st.textContent='\u2717 failed';}}
 if(db){ev.preventDefault();const n=db.getAttribute('data-del');
  if(!confirm('Delete '+n+'?'+(db.getAttribute('data-dir')==='1'?' Folder contents too — ':' ')+'this cannot be undone.'))return;
  try{const r=await fetch(BASE+'/_delete?path='+encodeURIComponent(DIR+'/'+n),{method:'POST'});
   st.textContent=r.ok?'\u2713 deleted':'\u2717 delete refused';if(r.ok)setTimeout(()=>location.reload(),400);}catch{st.textContent='\u2717 failed';}}
});
</script>` : '';
    const body = `
<h1>${LOGO_URI ? `<img class="logo" src="${LOGO_URI}" alt="">` : '🦀 '}<a href="${esc(bp)}/">ClawFileServer</a></h1>
${crumbs(bp, p)}
${upUI}
<table><tr><th>name</th><th>size</th><th class="mt">modified</th><th></th></tr>
${rootFor(p) && p !== rootFor(p).path ? `<tr><td class="name"><a href="${esc(encPath(bp, path.dirname(p)))}/">..</a></td><td></td><td class="mt"></td><td></td></tr>` : ''}
${rows.join('\n')}
</table>
${searchUI}
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
    if (ACTIVE.has(ext)) {
      // SECURITY: active content is forced to download and is sandboxed even if
      // opened; applies to raw, share, range, and fallback streaming alike.
      headers['Content-Disposition'] = `attachment; filename="${path.basename(p).replace(/"/g, '')}"`;
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
      headers['X-Content-Type-Options'] = 'nosniff';
    } else if (asDownload) {
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
      if (ext === '.md') {
        const body = `<h1>${esc(fname)}</h1>${crumbs(bp, p)}
<div class="bar">${editLink}<a href="${esc(encPath(bp, p))}?dl=1">download</a> <a href="#" id="tgl">show raw</a> <span class="sz">${fmtSize(st.size)} \u00b7 ${fmtTime(st.mtimeMs)}</span></div>
<div id="mdview" class="mdv"></div>
<pre id="mdraw" hidden>${esc(text)}</pre>
<script>
const MD=${JSON.stringify(text).replace(/</g, '\\u003c')};
function md(s){
 const E=s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const L=E.split('\\n');const o=[];let code=false,cb=[],ul=false,ol=false,para=[];
 const inl=t=>t.replace(/\`([^\`]+)\`/g,'<code>$1</code>')
  .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
  .replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<i>$2</i>')
  .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" rel="noopener">$1</a>');
 const closeL=()=>{if(ul){o.push('</ul>');ul=false}if(ol){o.push('</ol>');ol=false}};
 const flushP=()=>{if(para.length){o.push('<p>'+inl(para.join(' '))+'</p>');para=[]}};
 for(const ln of L){
  if(/^\`\`\`/.test(ln)){flushP();closeL();if(!code){code=true;cb=[]}else{o.push('<pre><code>'+cb.join('\\n')+'</code></pre>');code=false}continue}
  if(code){cb.push(ln);continue}
  let m;
  if(m=/^(#{1,6})\\s+(.*)$/.exec(ln)){flushP();closeL();const h=m[1].length;o.push('<h'+h+'>'+inl(m[2])+'</h'+h+'>');continue}
  if(/^(-{3,}|\\*{3,})\\s*$/.test(ln)){flushP();closeL();o.push('<hr>');continue}
  if(m=/^&gt;\\s?(.*)$/.exec(ln)){flushP();closeL();o.push('<blockquote>'+inl(m[1])+'</blockquote>');continue}
  if(m=/^[-*]\\s+(.*)$/.exec(ln)){flushP();if(ol){o.push('</ol>');ol=false}if(!ul){o.push('<ul>');ul=true}o.push('<li>'+inl(m[1])+'</li>');continue}
  if(m=/^\\d+\\.\\s+(.*)$/.exec(ln)){flushP();if(ul){o.push('</ul>');ul=false}if(!ol){o.push('<ol>');ol=true}o.push('<li>'+inl(m[1])+'</li>');continue}
  if(!ln.trim()){flushP();closeL();continue}
  para.push(ln);
 }
 if(code)o.push('<pre><code>'+cb.join('\\n')+'</code></pre>');
 flushP();closeL();
 return o.join('\\n');
}
document.getElementById('mdview').innerHTML=md(MD);
document.getElementById('tgl').addEventListener('click',(e)=>{e.preventDefault();const v=document.getElementById('mdview'),r=document.getElementById('mdraw');const raw=!r.hidden;r.hidden=raw;v.hidden=raw;e.target.textContent=raw?'show raw':'show rendered';});
</script>`;
        return sendHTML(res, 200, page(fname, body));
      }
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
    const gate = writeGate(rp);
    if (gate.err) return err(res, 403, gate.err);
    try { fs.mkdirSync(rp, { recursive: true }); }
    catch (e) { return err(res, 500, `mkdir failed: ${e.code}`); }
    log.info?.(`clawfileserver mkdir ${rp}`);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: rp }));
  }

  function handleDelete(res, qp) {
    const target = qp.get('path');
    if (!target) return err(res, 400, '?path=<absolute path> required');
    const rp = path.resolve('/' + String(target).replace(/^\/+/, ''));
    const gate = resolveContained(rp);
    if (gate.err) return err(res, 403, gate.err);
    if (gate.root.mode !== 'rw') return err(res, 403, 'deletion is limited to read-write roots');
    if (rp === gate.root.path) return err(res, 403, 'refusing to delete a root itself');
    let st;
    try { st = fs.lstatSync(rp); } catch (e) { return err(res, 404, `not found: ${e.code}`); }
    try {
      if (st.isDirectory()) fs.rmSync(rp, { recursive: true });
      else fs.unlinkSync(rp);
    } catch (e) { return err(res, 500, `delete failed: ${e.code}`); }
    log.info?.(`clawfileserver deleted ${rp} (${st.isDirectory() ? 'dir' : 'file'})`);
    jsonOut(res, 201, { ok: true, path: rp, kind: st.isDirectory() ? 'dir' : 'file' });
  }

  function handleMove(res, qp) {
    let from, to;
    try {
      from = path.resolve('/' + String(qp.get('from') || '').replace(/^\/+/, ''));
      to = path.resolve('/' + String(qp.get('to') || '').replace(/^\/+/, ''));
    } catch { return err(res, 400, 'bad paths'); }
    if (!qp.get('from') || !qp.get('to')) return err(res, 400, '?from=<abs>&to=<abs> required');
    const gf = resolveContained(from);
    if (gf.err) return err(res, 403, gf.err);
    const gt = writeGate(to);
    if (gt.err) return err(res, 403, gt.err);
    if (gf.root.mode !== 'rw' || gt.root.mode !== 'rw') return err(res, 403, 'move is limited to read-write roots');
    if (from === gf.root.path) return err(res, 403, 'refusing to move a root itself');
    if (to === from + '/') return err(res, 400, 'source and destination are the same');
    let st;
    try { st = fs.lstatSync(from); } catch (e) { return err(res, 404, `source not found: ${e.code}`); }
    try { fs.lstatSync(to); return err(res, 409, 'destination already exists'); } catch (e) { if (e.code !== 'ENOENT') return err(res, 500, `stat failed: ${e.code}`); }
    try { fs.renameSync(from, to); }
    catch (e) { return err(res, 500, `move failed: ${e.code}`); }
    log.info?.(`clawfileserver moved ${from} -> ${to}`);
    jsonOut(res, 201, { ok: true, from, to, kind: st.isDirectory() ? 'dir' : 'file' });
  }

  // ---- folder zip (streamed, data-descriptor entries: no buffering, no seek) --
  function dosDT(d) {
    return {
      t: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
      dt: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
    };
  }
  function zipWalk(dir, base, out, limit) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      if (out.length >= limit) return true;
      if (!cfg.showHidden && e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const rel = base ? base + '/' + e.name : e.name;
      if (st.isDirectory()) { if (zipWalk(abs, rel, out, limit)) return true; }
      else if (st.isFile()) out.push({ abs, rel, mtime: st.mtimeMs });
    }
    return false;
  }
  async function sendZip(req, res, dirPath) {
    const files = [];
    let truncated = false;
    try { truncated = zipWalk(dirPath, '', files, cfg.maxZipEntries || 2000); }
    catch (e) { return err(res, 500, `zip failed: ${e.code}`); }
    const baseName = path.basename(dirPath) || 'files';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${baseName.replace(/"/g, '')}.zip"`,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    let offset = 0;
    const w = async (buf) => { offset += buf.length; if (!res.write(buf)) await new Promise((r) => res.once('drain', r)); };
    const central = [];
    for (const f of files) {
      const nameBuf = Buffer.from(f.rel, 'utf8');
      const { t, dt } = dosDT(new Date(f.mtime));
      const localOff = offset;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6);
      lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(dt, 12);
      lh.writeUInt16LE(nameBuf.length, 26);
      await w(lh); await w(nameBuf);
      let crc = 0, csize = 0, usize = 0;
      try {
        const src = fs.createReadStream(f.abs);
        const gz = zlib.createDeflateRaw();
        src.on('data', (d) => { usize = (usize + d.length) % 0x100000000; crc = zlib.crc32(d, crc) >>> 0; });
        src.on('error', () => { res.destroy(); });
        src.pipe(gz);
        for await (const chunk of gz) { csize += chunk.length; if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); offset += chunk.length; }
        await finished(src);
      } catch { return res.destroy(); }
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(csize >>> 0, 8); dd.writeUInt32LE(usize >>> 0, 12);
      await w(dd);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(t, 12); ch.writeUInt16LE(dt, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize >>> 0, 20); ch.writeUInt32LE(usize >>> 0, 24);
      ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(localOff, 42);
      central.push(ch, nameBuf);
    }
    const cdStart = offset;
    for (const b of central) await w(b);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
    await w(eocd);
    log.info?.(`clawfileserver zip ${dirPath} (${files.length} files${truncated ? ', truncated' : ''})`);
    res.end();
  }

  function handleRecent(res, bp, qp) {
    const hours = Math.min(24 * 30, Math.max(0.01, parseFloat(qp.get('hours') || '24') || 24));
    const max = Math.min(500, Math.max(1, parseInt(qp.get('max') || '100', 10) || 100));
    const scanCap = cfg.searchScanLimit || 20000;
    const cutoff = Date.now() - hours * 3600e3;
    const single = qp.get('root');
    const walkRoots = single ? [{ path: path.resolve('/' + String(single).replace(/^\/+/, '')) }] : roots;
    if (single) { const g = resolveContained(walkRoots[0].path); if (g.err) return err(res, 403, g.err); }
    const items = [];
    let scanned = 0, truncated = false;
    outer: for (const root of walkRoots) {
      const stack = [[root.path, '']];
      while (stack.length) {
        const [dir, rel] = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (!cfg.showHidden && e.name.startsWith('.')) continue;
          if (++scanned > scanCap) { truncated = true; break outer; }
          const abs = path.join(dir, e.name);
          let st2;
          try { st2 = fs.lstatSync(abs); } catch { continue; }
          if (st2.isSymbolicLink()) continue;
          const isDir = st2.isDirectory();
          if (isDir) stack.push([abs, rel ? rel + '/' + e.name : e.name]);
          if (st2.mtimeMs < cutoff) continue;
          const relName = rel ? rel + '/' + e.name : e.name;
          items.push({ path: abs, name: e.name, rel: relName, root: root.path, dir: isDir,
            size: st2.isFile() ? st2.size : null, mtime: Math.round(st2.mtimeMs) });
        }
      }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    jsonOut(res, 200, { hours, now: Date.now(), cutoff: Math.round(cutoff), scanned, truncated, count: Math.min(items.length, max), items: items.slice(0, max) });
  }

  function handleSearch(res, bp, qp) {
    const q = String(qp.get('q') || '').trim();
    if (!q) return err(res, 400, '?q=<search term or *glob*> required');
    const rp = path.resolve('/' + String(qp.get('root') || '/').replace(/^\/+/, ''));
    { const g = resolveContained(rp); if (g.err) return err(res, 403, g.err); }
    try { if (!fs.statSync(rp).isDirectory()) throw new Error('notdir'); }
    catch { return err(res, 404, 'search root is not a directory'); }
    const wantContent = qp.get('content') === '1';
    const max = Math.min(1000, Math.max(1, parseInt(qp.get('max') || '200', 10) || 200));
    const scanCap = cfg.searchScanLimit || 20000;
    const glob = /[*?]/.test(q);
    const rx = glob ? new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
    const ql = q.toLowerCase();
    const nameHit = (n) => (rx ? rx.test(n) : n.toLowerCase().includes(ql));
    const matches = [];
    let scanned = 0, truncated = false;
    const stack = [[rp, '']];
    outer: while (stack.length) {
      const [dir, rel] = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!cfg.showHidden && e.name.startsWith('.')) continue;
        if (++scanned > scanCap) { truncated = true; break outer; }
        const abs = path.join(dir, e.name);
        let st2;
        try { st2 = fs.lstatSync(abs); } catch { continue; }
        if (st2.isSymbolicLink()) continue;
        const relName = rel ? rel + '/' + e.name : e.name;
        const isDir = st2.isDirectory();
        if (isDir) stack.push([abs, relName]);
        let hit = nameHit(e.name) ? 'name' : null;
        if (!hit && wantContent && !isDir && TEXTY.has(path.extname(e.name).toLowerCase()) && st2.size <= 512 * 1024) {
          try { if (fs.readFileSync(abs, 'utf8').toLowerCase().includes(ql)) hit = 'content'; } catch { /* unreadable */ }
        }
        if (hit) {
          matches.push({ path: abs, name: e.name, rel: relName, dir: isDir, size: st2.isFile() ? st2.size : null, mtime: Math.round(st2.mtimeMs), match: hit });
          if (matches.length >= max) { truncated = true; break outer; }
        }
      }
    }
    matches.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    if (qp.get('html') === '1') {
      const rows = matches.map((m) => `<tr><td class="name">${m.dir ? '📁' : '📄'} <a class="${m.dir ? '' : 'd'}" href="${esc(encPath(bp, m.path))}${m.dir ? '/' : ''}">${esc(m.rel)}</a></td>` +
        `<td class="sz">${m.size != null ? fmtSize(m.size) : '-'}</td><td><span class="badge">${m.match}</span></td></tr>`).join('\n');
      const body = `<h1>🔎 ${esc(q)}</h1>
<div class="bar"><span class="note">${matches.length} match(es) under ${esc(rp)} \u00b7 ${scanned} scanned${truncated ? ' (truncated)' : ''}</span> \u00b7 <a href="${esc(encPath(bp, rp))}/">back</a></div>
<table><tr><th>name</th><th>size</th><th>match</th></tr>${rows || '<tr><td class="note" colspan="3">no matches</td></tr>'}</table>`;
      return sendHTML(res, 200, page(`search: ${q}`, body));
    }
    jsonOut(res, 200, { root: rp, q, content: wantContent, scanned, truncated, matches });
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
    const ck = (req.headers.cookie || '').split(/;/).map((s) => s.trim()).find((s) => s.startsWith('cfs_t='));
    const cv = ck ? ck.slice(6) : '';
    return (typeof q === 'string' && q.length > 0 && eqSafe(q, auth.token))
      || (typeof h === 'string' && h.length > 0 && eqSafe(h, auth.token))
      || (cv.length > 0 && eqSafe(cv, auth.token));
  }

  // ---- expiring share links + drop portals (capability URLs) ----------------
  // Records live in a JSON state file so they survive restarts. The code IS the
  // credential for /s/ and /d/; admin endpoints always require basic auth.
  const shCfg = cfg.shares || {};
  const shEnabled = shCfg.enabled !== false && !!shCfg.stateFile;
  const store = { shares: {}, drops: {} };
  if (shEnabled) {
    try {
      const loaded = JSON.parse(fs.readFileSync(shCfg.stateFile, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        Object.assign(store.shares, loaded.shares || {});
        Object.assign(store.drops, loaded.drops || {});
      }
    } catch { /* first run or unreadable: start fresh */ }
    // drop records dead for more than 7 days
    const cutoff = Date.now() - 7 * 864e5;
    for (const [kind, coll] of [['shares', store.shares], ['drops', store.drops]]) {
      for (const [code, rec] of Object.entries(coll)) {
        if (rec.exp && rec.exp < cutoff) delete coll[code];
      }
    }
  }
  function saveStore() {
    if (!shCfg.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(shCfg.stateFile), { recursive: true });
      const tmpF = `${shCfg.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmpF, JSON.stringify(store, null, 1));
      fs.renameSync(tmpF, shCfg.stateFile);
    } catch (e) { log.error?.(`clawfileserver: share store save failed: ${e?.code || e}`); }
  }
  const statusOf = (rec) => rec.rev ? 'revoked'
    : (rec.exp && Date.now() > rec.exp) ? 'expired'
    : (rec.max && rec.n >= rec.max) ? 'exhausted' : 'active';
  function jsonOut(res, code, obj) {
    const buf = Buffer.from(JSON.stringify(obj, null, 1));
    res.writeHead(code, {
      'Content-Type': 'application/json', 'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    });
    res.end(buf);
  }
  function ttlFrom(qp) {
    const def = parseTtl(shCfg.defaultTtl || '24h', 864e5);
    const maxTtl = parseTtl(shCfg.maxTtl || '30d', 30 * 864e5);
    const ttl = qp.get('ttl') == null ? def : parseTtl(qp.get('ttl'), NaN);
    if (!(ttl > 0)) return { err: 'bad ttl (use e.g. 90m, 24h, 7d)' };
    if (ttl > maxTtl) return { err: `ttl exceeds maxTtl (${shCfg.maxTtl || '30d'})` };
    return { ttl };
  }
  function handleShareCreate(req, res, bp, qp) {
    if (!shEnabled) return err(res, 503, 'shares are disabled (no shares.stateFile configured)');
    const target = qp.get('path');
    if (!target) return err(res, 400, '?path=<absolute file or dir> required');
    const rp = path.resolve('/' + String(target).replace(/^\/+/, ''));
    { const g = resolveContained(rp); if (g.err) return err(res, 403, g.err); }
    let st;
    try { st = fs.statSync(rp); } catch (e) { return err(res, 404, `not found: ${e.code}`); }
    const t = ttlFrom(qp); if (t.err) return err(res, 400, t.err);
    const maxN = Math.max(0, parseInt(qp.get('max') || '0', 10) || 0);
    let code; do { code = genCode(); } while (store.shares[code]);
    const rec = { code, path: rp, dir: st.isDirectory(), exp: Date.now() + t.ttl, max: maxN, n: 0, rev: false, ctime: Date.now() };
    store.shares[code] = rec; saveStore();
    log.info?.(`clawfileserver share created ${code} -> ${rp} (${statusOf(rec)})`);
    jsonOut(res, 201, { ok: true, code, url: `${bp}/s/${code}`, kind: rec.dir ? 'dir' : 'file', expires: new Date(rec.exp).toISOString(), maxDownloads: maxN || 'unlimited' });
  }
  function handleDropCreate(req, res, bp, qp) {
    if (!shEnabled) return err(res, 503, 'drops are disabled (no shares.stateFile configured)');
    const target = qp.get('dir');
    if (!target) return err(res, 400, '?dir=<absolute destination dir> required');
    const rp = path.resolve('/' + String(target).replace(/^\/+/, ''));
    { const g = writeGate(rp); if (g.err) return err(res, 403, g.err); }
    const t = ttlFrom(qp); if (t.err) return err(res, 400, t.err);
    const maxN = Math.max(0, parseInt(qp.get('max') || '0', 10) || 0);
    let code; do { code = genCode(); } while (store.drops[code]);
    const rec = { code, dir: rp, exp: Date.now() + t.ttl, max: maxN, n: 0, rev: false, ctime: Date.now() };
    store.drops[code] = rec; saveStore();
    log.info?.(`clawfileserver drop portal created ${code} -> ${rp}`);
    jsonOut(res, 201, { ok: true, code, url: `${bp}/d/${code}`, dir: rp, expires: new Date(rec.exp).toISOString(), maxUploads: maxN || 'unlimited' });
  }
  function handleSharesList(res) {
    const row = (kind, rec) => ({
      code: rec.code, kind, path: rec.path || rec.dir, status: statusOf(rec),
      created: new Date(rec.ctime).toISOString(), expires: new Date(rec.exp).toISOString(),
      used: rec.n, max: rec.max || 'unlimited',
    });
    jsonOut(res, 200, {
      shares: Object.values(store.shares).map((r) => row('share', r)),
      drops: Object.values(store.drops).map((r) => row('drop', r)),
    });
  }
  function handleRevoke(req, res, qp) {
    const code = qp.get('code') || '';
    const rec = store.shares[code] || store.drops[code];
    if (!rec) return err(res, 404, 'no such code');
    rec.rev = true; saveStore();
    jsonOut(res, 200, { ok: true, code, status: 'revoked' });
  }

  function shareListing(res, bp, rec, rel) {
    let ents;
    try { ents = fs.readdirSync(rec.path, { withFileTypes: true }); }
    catch (e) { return err(res, 500, `cannot read share dir: ${e.code}`); }
    if (!cfg.showHidden) ents = ents.filter((e) => !e.name.startsWith('.'));
    const rows = ents.map((e) => {
      let st = null; try { st = fs.statSync(path.join(rec.path, e.name)); } catch {}
      const href = `${bp}/s/${rec.code}/${[...rel, e.name].map(encodeURIComponent).join('/')}`;
      return `<tr><td>${e.isDirectory() ? '📁' : '📄'} <a href="${esc(href)}">${esc(e.name)}</a></td>` +
        `<td>${st && st.isFile() ? fmtSize(st.size) : ''}</td></tr>`;
    }).join('\n');
    sendHTML(res, 200, page('shared folder',
      `<h1>📁 shared folder</h1><div class="bar"><span class="note">${esc(rel.join('/') || 'files')}</span></div>` +
      `<table><tr><th>name</th><th>size</th></tr>${rows}</table>`));
  }

  function handleShareGet(req, res, bp, seg) {
    const parts = seg.split('/').filter(() => true).filter((s, i) => !(i === 0 && s === ''));
    const code = parts.shift() || '';
    const rec = store.shares[code];
    if (!rec) return err(res, 404, 'no such share');
    const status = statusOf(rec);
    if (status !== 'active') return err(res, 410, `this share link is ${status}`);
    let target;
    if (rec.dir) {
      let rel;
      try { rel = parts.map(decodeURIComponent); }
      catch { return err(res, 400, 'bad URL encoding'); }
      target = path.resolve(rec.path, ...rel);
      if (target !== rec.path && !target.startsWith(rec.path + '/')) return err(res, 403, 'outside share');
    } else {
      if (parts.length) return err(res, 404, 'not found');
      target = rec.path;
    }
    { const g = resolveContained(target); if (g.err) return err(res, 403, g.err); }
    let st;
    try { st = fs.statSync(target); } catch { return err(res, 404, 'file no longer exists'); }
    if (st.isDirectory()) {
      if (rec.dir) return shareListing(res, bp, rec, parts.map((x) => { try { return decodeURIComponent(x); } catch { return x; } }));
      return err(res, 404, 'not a file');
    }
    // count one download per non-continuation GET
    if (req.method !== 'HEAD') {
      const rg = req.headers.range;
      if (!rg || /^bytes=0-/.test(rg)) { rec.n++; saveStore(); }
    }
    const dl = /[?&]dl=1/.test(req.url || '');
    return streamFile(req, res, target, st, dl);
  }

  function dropPage(res, bp, rec) {
    const left = Math.max(0, Math.round((rec.exp - Date.now()) / 1000));
    const body = `<h1>📥 drop files</h1>
<div class="bar"><span class="note" id="cd">link expires in ${left}s</span> · <span class="sz">${rec.max ? `${rec.max - rec.n} of ${rec.max} uploads left` : 'unlimited uploads'}</span></div>
<div id="zone" style="border:2px dashed #2A4E7C;border-radius:10px;padding:48px;text-align:center;color:#7FA8C9">drag &amp; drop files here — or <label style="color:#38BDF8;cursor:pointer">browse<input id="f" type="file" multiple hidden></label></div>
<div id="list" style="margin-top:14px"></div>
<script>
const CODE=${JSON.stringify(rec.code)},BP=${JSON.stringify(bp)};
const zone=document.getElementById('zone'),list=document.getElementById('list'),f=document.getElementById('f');
let secs=${left};
setInterval(()=>{secs=document.getElementById('cd').textContent='link expires in '+Math.max(0,--secs)+'s';},1000);
function up(file){
  const row=document.createElement('div');row.className='bar';
  row.innerHTML='<span>'+esc(file.name)+' ('+fmt(file.size)+')</span> <progress max="100" value="0" style="width:200px"></progress> <span class="sz">0%</span>';
  list.appendChild(row);
  const pr=row.querySelector('progress'),st=row.querySelector('.sz');
  const x=new XMLHttpRequest();
  x.open('POST',BP+'/d/'+CODE+'?name='+encodeURIComponent(file.name));
  x.upload.onprogress=(e)=>{if(e.lengthComputable){pr.value=Math.round(e.loaded*100/e.total);st.textContent=pr.value+'%';}};
  x.onload=()=>{try{const j=JSON.parse(x.responseText);if(j.ok){st.textContent='\u2713 '+j.name;pr.value=100;}else{st.textContent='\u2717 '+(j.error||('HTTP '+x.status));}}catch{st.textContent='\u2717 HTTP '+x.status;}};
  x.onerror=()=>{st.textContent='\u2717 network error';};
  x.send(file);
}
function esc(s){return s.replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(n){return n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(1)+' MiB';}
addEventListener('dragover',(e)=>{e.preventDefault();zone.style.borderColor='#FF7A29';});
addEventListener('dragleave',()=>{zone.style.borderColor='#2A4E7C';});
addEventListener('drop',(e)=>{e.preventDefault();zone.style.borderColor='#2A4E7C';[...e.dataTransfer.files].forEach(up);});
f.addEventListener('change',(e)=>{[...e.target.files].forEach(up);});
</script>`;
    sendHTML(res, 200, page('drop files', body));
  }

  function handleDropUpload(req, res, bp, code) {
    const rec = store.drops[code];
    if (!rec) return err(res, 404, 'no such drop portal');
    const status = statusOf(rec);
    if (status !== 'active') return err(res, 410, `this drop portal is ${status}`);
    const qp = new URLSearchParams((req.url || '').split('?')[1] || '');
    const name = safeName(qp.get('name') || req.headers['x-filename'] || 'file');
    const maxBytes = shCfg.maxUploadBytes || 2 * 1024 ** 3;
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(rec.dir, day);
    { // re-verify containment at write time: the drop dir could have been swapped
      // for a symlink since the portal was created
      const g = writeGate(dir);
      if (g.err) return err(res, 403, g.err);
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return err(res, 500, `mkdir failed: ${e.code}`); }
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      target = path.join(dir, `${name.slice(0, Math.max(0, name.length - ext.length))}_${Date.now()}${ext}`);
    }
    const tmpF = `${target}.upload-${process.pid}-${Date.now()}`;
    const out = fs.createWriteStream(tmpF);
    let size = 0, failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes && !failed) {
        failed = true;
        req.unpipe(out);
        out.end();
        fs.unlink(tmpF, () => {});
        err(res, 413, `file exceeds limit (${fmtSize(maxBytes)})`);
      }
    });
    req.on('error', () => { failed = true; fs.unlink(tmpF, () => {}); res.destroy(); });
    out.on('error', (e) => { if (failed) return; failed = true; fs.unlink(tmpF, () => {}); err(res, 500, `write failed: ${e.code}`); });
    out.on('finish', () => {
      if (failed) return;
      try { fs.renameSync(tmpF, target); }
      catch (e) { fs.unlink(tmpF, () => {}); return err(res, 500, `rename failed: ${e.code}`); }
      rec.n++; saveStore();
      log.info?.(`clawfileserver drop ${code} received ${target} (${fmtSize(size)})`);
      jsonOut(res, 201, { ok: true, name: path.basename(target), size });
    });
    req.pipe(out);
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
      // Strip the route prefix. Dedicated vhostnames that proxy us under a bare
      // hostname (e.g. owner-redacted rewriting ^/(.*)$ -> /clawfileserver/$1)
      // re-add the prefix to our own generated absolute links, so tolerate it
      // appearing more than once.
      while (bp && (raw === bp || raw.startsWith(bp + '/'))) raw = raw.slice(bp.length) || '/';
      let query = '';
      const q = raw.indexOf('?');
      if (q >= 0) { query = raw.slice(q); raw = raw.slice(0, q); }
      let p;
      try { p = decodeURIComponent(raw); }
      catch { return err(res, 400, 'bad URL encoding'); }
      if (p.includes('\0')) return err(res, 400, 'bad path');
      if (!p.startsWith('/')) p = '/' + p;

      // public capability routes: the code in the URL is the credential
      if (p.startsWith('/s/') || p === '/s') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'GET/HEAD only');
        return handleShareGet(req, res, bp, p.slice(3));
      }
      if (p.startsWith('/d/') || p === '/d') {
        const code = p.slice(3).replace(/\/+$/, '');
        if (req.method === 'GET' || req.method === 'HEAD') {
          const rec = store.drops[code];
          if (!rec) return err(res, 404, 'no such drop portal');
          const status = statusOf(rec);
          if (status !== 'active') return err(res, 410, `this drop portal is ${status}`);
          return dropPage(res, bp, rec);
        }
        if (req.method === 'POST') return handleDropUpload(req, res, bp, code.replace(/\/+$/, ''));
        return err(res, 405, 'GET/POST only');
      }

      if (auth.mode === 'basic' && !basicAuthed(req)) {
        const qp0 = new URLSearchParams(query);
        if (!tokenAuthed(req, qp0)) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ClawFileServer"', 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('ClawFileServer: login required');
          return true;
        }
        // Token-link browsing: promote ?t= to a session cookie so links, forms,
        // and subresources (thumbnails) keep working without rewriting every href.
        if (qp0.get('t') === auth.token) {
          res.setHeader('Set-Cookie', `cfs_t=${auth.token}; Path=/; HttpOnly; SameSite=Lax`);
        }
      }
      const url = p + query;
      req.url = url; // downstream helpers inspect query flags on req.url
      const qp = new URLSearchParams(query);

      // share/drop admin endpoints: basic auth only — the read-only token must
      // never create, list, or revoke links.
      if (p === '/_share' || p === '/_drop' || p === '/_revoke' || p === '/_shares') {
        if (auth.mode === 'basic' && !basicAuthed(req)) return err(res, 403, 'share admin requires basic auth (the read-only token is not enough)');
        if (p === '/_shares' && req.method === 'GET') return handleSharesList(res);
        if (req.method !== 'POST') return err(res, 405, 'POST required for share admin actions');
        if (p === '/_share') return handleShareCreate(req, res, bp, qp);
        if (p === '/_drop') return handleDropCreate(req, res, bp, qp);
        return handleRevoke(req, res, qp);
      }

      if (p === '/' || p === '') return sendHTML(res, 200, rootsIndex(bp));

      if (req.method === 'PUT') {
        const rp = path.resolve(p);
        const gate = writeGate(rp);
        if (gate.err) return err(res, 403, gate.err);
        return handlePut(req, res, rp);
      }
      if (req.method === 'POST' && p === '/_mkdir') return handleMkdir(req, res, url);
      if (req.method === 'POST' && p === '/_delete') return handleDelete(res, qp);
      if (req.method === 'POST' && p === '/_move') return handleMove(res, qp);
      if ((req.method === 'GET' || req.method === 'HEAD') && p === '/_search') return handleSearch(res, bp, qp);
      if ((req.method === 'GET' || req.method === 'HEAD') && p === '/_recent') return handleRecent(res, bp, qp);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return err(res, 405, 'GET/HEAD/PUT/POST(/_mkdir,/ _delete,/ _move) only');
      }

      const rp = path.resolve(p);
      { const g = resolveContained(rp); if (g.err) return err(res, 403, g.err); }
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
        if (/[?&]zip=1/.test(query)) return sendZip(req, res, rp.replace(/\/+$/, '') || '/');
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
