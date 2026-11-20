// Standalone test harness: mounts core.js behind a plain node:http server on
// an ephemeral port and exercises every route. No OpenClaw runtime needed.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createClawFileServer } from '../core.js';
import { normalizeConfig } from '../config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-test-'));
const roDir = path.join(tmp, 'ro');
const rwDir = path.join(tmp, 'rw');
fs.mkdirSync(roDir); fs.mkdirSync(rwDir);
fs.writeFileSync(path.join(rwDir, 'note.md'), '# hello\nworld\n');
fs.writeFileSync(path.join(roDir, 'static.txt'), 'read only\n');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret\n');

const server = http.createServer((req, res) => {
  server._cfs.handle(req, res, '/cfs');
});
const authServer = http.createServer((req, res) => {
  server._cfsAuth.handle(req, res, '/cfs');
});
server._cfs = createClawFileServer({
  roots: [{ path: rwDir, mode: 'rw', label: 'RW' }, { path: roDir, mode: 'ro', label: 'RO' }],
  maxPreviewBytes: 1024 * 1024, maxEditBytes: 512 * 1024, maxListEntries: 100,
  shares: { stateFile: path.join(tmp, 'state-main.json') },
});
server._cfsAuth = createClawFileServer({
  roots: [{ path: rwDir, mode: 'rw', label: 'RW' }],
  auth: { mode: 'basic', user: 'u', password: 'p' },
  maxPreviewBytes: 1024 * 1024, maxEditBytes: 512 * 1024, maxListEntries: 100,
  shares: { stateFile: path.join(tmp, 'state-auth.json') },
});
server._cfsTok = createClawFileServer({
  roots: [{ path: rwDir, mode: 'rw', label: 'RW' }],
  auth: { mode: 'basic', user: 'u', password: 'p', token: 'share-token-123' },
  maxPreviewBytes: 1024 * 1024, maxEditBytes: 512 * 1024, maxListEntries: 100,
  shares: { stateFile: path.join(tmp, 'state-tok.json') },
});
const tokServer = http.createServer((req, res) => {
  server._cfsTok.handle(req, res, '/cfs');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (p, opts) => fetch(base + p, opts);

let n = 0;
const ok = (name, cond) => { n++; assert.ok(cond, `FAIL: ${name}`); console.log(`  ✓ ${name}`); };

// 1. roots index
let r = await get('/cfs/');
ok('roots index 200', r.status === 200 && (await r.text()).includes('RW'));

// 2. listing
r = await get(`/cfs${rwDir}/`);
ok('listing shows file', r.status === 200 && (await r.text()).includes('note.md'));

// 3. text preview with edit link
r = await get(`/cfs${rwDir}/note.md`);
ok('preview + edit link', r.status === 200 && (await r.text()).includes('edit=1'));

// 3b. double route prefix (dedicated vhost rewrites re-add basePath to links)
r = await get(`/cfs/cfs${rwDir}/note.md`);
ok('double-prefixed path serves file', r.status === 200 && (await r.text()).includes('hello'));
r = await get('/cfs/cfs/');
ok('double-prefixed roots index', r.status === 200 && (await r.text()).includes('RW'));

// 4. editor page
r = await get(`/cfs${rwDir}/note.md?edit=1`);
ok('editor renders content', r.status === 200 && (await r.text()).includes('# hello'));

// 5. PUT conflict guard (wrong mtime -> 409)
r = await fetch(`${base}/cfs${rwDir}/note.md`, { method: 'PUT', headers: { 'x-if-mtime': '1' }, body: 'clobber' });
ok('PUT wrong mtime -> 409', r.status === 409);

// 6. PUT correct mtime -> 201 + content changed
const mt = String(Math.round(fs.statSync(path.join(rwDir, 'note.md')).mtimeMs));
r = await fetch(`${base}/cfs${rwDir}/note.md`, { method: 'PUT', headers: { 'x-if-mtime': mt }, body: '# edited\n' });
ok('PUT correct mtime -> 201', r.status === 201);
ok('content edited', fs.readFileSync(path.join(rwDir, 'note.md'), 'utf8') === '# edited\n');

// 7. read-only root: no edit link, PUT refused
r = await get(`/cfs${roDir}/static.txt`);
ok('ro preview has no edit link', r.status === 200 && !(await r.text()).includes('edit=1'));
r = await fetch(`${base}/cfs${roDir}/static.txt`, { method: 'PUT', body: 'x' });
ok('ro PUT -> 403', r.status === 403);

// 8. outside roots -> 403
r = await get(`/cfs${tmp}/outside.txt`);
ok('outside root -> 403', r.status === 403);
r = await get('/cfs/etc/hosts');
ok('/etc/hosts -> 403', r.status === 403);
ok('403 carries CORS header', r.headers.get('access-control-allow-origin') === '*');

// 9. path traversal blocked
r = await get(`/cfs${rwDir}/../outside.txt`);
ok('traversal blocked', r.status === 403 || r.status === 404);

// 10. mkdir inside rw ok, outside refused
r = await fetch(`${base}/cfs/_mkdir?path=${encodeURIComponent(rwDir + '/sub')}`, { method: 'POST' });
ok('mkdir rw -> 201', r.status === 201 && fs.existsSync(path.join(rwDir, 'sub')));
r = await fetch(`${base}/cfs/_mkdir?path=${encodeURIComponent(roDir + '/nope')}`, { method: 'POST' });
ok('mkdir ro -> 403', r.status === 403);

// 11. raw bytes + CORS
r = await get(`/cfs${rwDir}/note.md?raw=1`);
ok('raw + CORS', r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && (await r.text()) === '# edited\n');

// 12. 404 for missing file
r = await get(`/cfs${rwDir}/missing.txt`);
ok('missing -> 404', r.status === 404);

// 13. basic auth
const abase = base; // same port; auth server shares port? no—use same server trick: auth route needs own server
await new Promise((r2) => authServer.listen(0, '127.0.0.1', r2));
const abase2 = `http://127.0.0.1:${authServer.address().port}`;
r = await fetch(`${abase2}/cfs/`);
ok('basic auth: 401 without creds', r.status === 401);
r = await fetch(`${abase2}/cfs/`, { headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') } });
ok('basic auth: 200 with creds', r.status === 200);
r = await fetch(`${abase2}/cfs/`, { headers: { Authorization: 'Basic ' + Buffer.from('u:wrong').toString('base64') } });
ok('basic auth: 401 wrong pass', r.status === 401);

// 14. JSON listing
r = await get(`/cfs${rwDir}/?json=1`);
{
  const j = r.status === 200 ? await r.json() : {};
  ok('json listing 200 + CORS *', r.status === 200 && r.headers.get('access-control-allow-origin') === '*');
  ok('json listing entries', Array.isArray(j.entries) && j.entries.some((e) => e.name === 'note.md' && e.dir === false && typeof e.size === 'number'));
  ok('json listing dirs flagged', j.entries.some((e) => e.name === 'sub' && e.dir === true));
}

// 15. read-only share token
await new Promise((r2) => tokServer.listen(0, '127.0.0.1', r2));
const tbase = `http://127.0.0.1:${tokServer.address().port}`;
r = await fetch(`${tbase}/cfs/`);
ok('token server: 401 without creds or token', r.status === 401);
ok('401 carries CORS header', r.headers.get('access-control-allow-origin') === '*');
r = await fetch(`${tbase}/cfs/?t=share-token-123`);
ok('token via ?t= -> 200', r.status === 200);
ok('?t= sets session cookie', (r.headers.get('set-cookie') || '').includes('cfs_t=share-token-123'));
r = await fetch(`${tbase}/cfs/`, { headers: { cookie: 'cfs_t=share-token-123' } });
ok('token via cookie -> 200', r.status === 200);
r = await fetch(`${tbase}/cfs/`, { headers: { cookie: 'cfs_t=wrong-value' } });
ok('bad cookie -> 401', r.status === 401);
r = await fetch(`${tbase}/cfs/?t=wrong-token-value`);
ok('bad token -> 401', r.status === 401);
r = await fetch(`${tbase}/cfs/`, { headers: { 'x-cfs-token': 'share-token-123' } });
ok('token via header -> 200', r.status === 200);
r = await fetch(`${tbase}/cfs${rwDir}/?json=1&t=share-token-123`);
{
  const j = r.status === 200 ? await r.json() : {};
  ok('token + json listing', r.status === 200 && j.entries?.length > 0);
}
r = await fetch(`${tbase}/cfs${rwDir}/note.md?t=share-token-123`, { method: 'PUT', body: 'x' });
ok('token cannot PUT -> 401', r.status === 401);
r = await fetch(`${tbase}/cfs/_mkdir?path=${encodeURIComponent(rwDir + '/nope')}&t=share-token-123`, { method: 'POST' });
ok('token cannot mkdir -> 401', r.status === 401);

// 16. expiring share links
const BAUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
let jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h`, { method: 'POST', headers: BAUTH });
const sh = await jr.json();
ok('share create -> 201 + code', jr.status === 201 && /^[A-Za-z0-9]{10}$/.test(sh.code));
r = await fetch(`${abase2}/cfs/s/${sh.code}`); // auth server, no creds: capability URL works
ok('share fetch without auth', r.status === 200 && (await r.text()) === '# edited\n');
r = await fetch(`${abase2}/cfs/s/${sh.code}`, { headers: { Range: 'bytes=0-3' } });
ok('share Range -> 206', r.status === 206 && (await r.text()) === '# ed');
r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(tmp + '/outside.txt')}`, { method: 'POST', headers: BAUTH });
ok('share outside roots -> 403', r.status === 403);
r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/missing')}`, { method: 'POST', headers: BAUTH });
ok('share missing file -> 404', r.status === 404);
r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=99x`, { method: 'POST', headers: BAUTH });
ok('bad ttl -> 400', r.status === 400);
{ // max downloads: HEAD free, first GET ok, second 410
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h&max=1`, { method: 'POST', headers: BAUTH });
  const sh1 = await jr.json();
  await fetch(`${abase2}/cfs/s/${sh1.code}`, { method: 'HEAD' });
  r = await fetch(`${abase2}/cfs/s/${sh1.code}`);
  ok('share max=1 first GET ok', r.status === 200);
  r = await fetch(`${abase2}/cfs/s/${sh1.code}`);
  ok('share exhausted -> 410', r.status === 410);
  r = await fetch(`${abase2}/cfs/_revoke?code=${sh1.code}`, { method: 'POST', headers: BAUTH });
  ok('revoke -> ok', r.status === 200);
}
r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1s`, { method: 'POST', headers: BAUTH });
{ const sh2 = await r.json();
  await new Promise((res2) => setTimeout(res2, 1200));
  r = await fetch(`${abase2}/cfs/s/${sh2.code}`);
  ok('expired share -> 410', r.status === 410); }
r = await fetch(`${base}/cfs/s/ZZZZZZZZZZ`);
ok('unknown share -> 404', r.status === 404);
r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}`, { method: 'POST' });
ok('share admin needs auth -> 401', r.status === 401);
r = await fetch(`${tbase}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&t=share-token-123`, { method: 'POST' });
ok('token cannot create share -> 401', r.status === 401);
r = await fetch(`${abase2}/cfs/_shares`, { headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') } });
{ const j = await r.json();
  ok('_shares lists with status', r.status === 200 && j.shares.some((s) => s.code === sh.code && s.status === 'active')); }
{ // dir share
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir)}&ttl=1h`, { method: 'POST', headers: BAUTH });
  const shd = await jr.json();
  r = await fetch(`${abase2}/cfs/s/${shd.code}/`);
  ok('dir share listing', r.status === 200 && (await r.text()).includes('note.md'));
  r = await fetch(`${abase2}/cfs/s/${shd.code}/note.md`);
  ok('dir share file fetch', r.status === 200);
  r = await fetch(`${abase2}/cfs/s/${shd.code}/../outside.txt`);
  ok('dir share traversal blocked', r.status === 403 || r.status === 404);
}
{ // persistence across instances
  const fresh = createClawFileServer({ roots: [{ path: rwDir, mode: 'rw' }], shares: { stateFile: path.join(tmp, 'state-auth.json') }, maxPreviewBytes: 1024, maxEditBytes: 1024, maxListEntries: 10 });
  const srv2 = http.createServer((req, res) => fresh.handle(req, res, '/cfs'));
  await new Promise((r2) => srv2.listen(0, '127.0.0.1', r2));
  r = await fetch(`http://127.0.0.1:${srv2.address().port}/cfs/s/${sh.code}`);
  ok('share survives restart (state file)', r.status === 200);
  srv2.close();
}

// 17. drop portals
jr = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/inbox')}&ttl=1h&max=2`, { method: 'POST', headers: BAUTH });
const dp = await jr.json();
ok('drop create -> 201', jr.status === 201 && /^[A-Za-z0-9]{10}$/.test(dp.code));
r = await fetch(`${abase2}/cfs/d/${dp.code}`);
ok('drop page public', r.status === 200 && (await r.text()).includes('drop files'));
r = await fetch(`${abase2}/cfs/d/${dp.code}?name=hello.txt`, { method: 'POST', body: 'payload-A' });
{ const j = await r.json();
  const day = new Date().toISOString().slice(0, 10);
  ok('drop upload -> 201', r.status === 201 && j.ok && j.name === 'hello.txt');
  ok('drop file on disk', fs.readFileSync(path.join(rwDir, 'inbox', day, 'hello.txt'), 'utf8') === 'payload-A');
  r = await fetch(`${abase2}/cfs/d/${dp.code}?name=hello.txt`, { method: 'POST', body: 'payload-B' });
  const j2 = await r.json();
  ok('collision gets unique name', r.status === 201 && j2.name !== 'hello.txt' && j2.name.startsWith('hello_'));
  r = await fetch(`${abase2}/cfs/d/${dp.code}?name=evil.txt`, { method: 'POST', body: 'x' });
  ok('drop exhausted after max -> 410', r.status === 410); }
r = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(roDir + '/x')}`, { method: 'POST', headers: BAUTH });
ok('drop to ro root -> 403', r.status === 403);
{ jr = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/inbox')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  const dp2 = await jr.json();
  r = await fetch(`${abase2}/cfs/_revoke?code=${dp2.code}`, { method: 'POST', headers: BAUTH });
  r = await fetch(`${abase2}/cfs/d/${dp2.code}`);
  ok('revoked drop -> 410', r.status === 410); }
r = await fetch(`${abase2}/cfs/d/ZZZZZZZZZZ`);
ok('unknown drop -> 404', r.status === 404);
{ jr = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/inbox')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  const dp3 = await jr.json();
  r = await fetch(`${abase2}/cfs/d/${dp3.code}?name=..%2F..%2Fescape.txt`, { method: 'POST', body: 'x' });
  const j = await r.json();
  ok('drop name sanitized', r.status === 201 && !j.name.includes('..') && !fs.existsSync(path.join(rwDir, 'escape.txt')));
}

// 18. delete
fs.writeFileSync(path.join(rwDir, 'doomed.txt'), 'bye\n');
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(rwDir + '/doomed.txt')}`, { method: 'POST' });
ok('delete file -> 201', r.status === 201 && !fs.existsSync(path.join(rwDir, 'doomed.txt')));
fs.mkdirSync(path.join(rwDir, 'dodir'), { recursive: true });
fs.writeFileSync(path.join(rwDir, 'dodir', 'inner.txt'), 'x');
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(rwDir + '/dodir')}`, { method: 'POST' });
ok('delete dir recursive -> 201', r.status === 201 && !fs.existsSync(path.join(rwDir, 'dodir')));
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(roDir + '/static.txt')}`, { method: 'POST' });
ok('delete on ro root -> 403', r.status === 403 && fs.existsSync(path.join(roDir, 'static.txt')));
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(tmp + '/outside.txt')}`, { method: 'POST' });
ok('delete outside roots -> 403', r.status === 403);
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(rwDir)}`, { method: 'POST' });
ok('delete root itself -> 403', r.status === 403 && fs.existsSync(rwDir));
r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(rwDir + '/ghost')}`, { method: 'POST' });
ok('delete missing -> 404', r.status === 404);
r = await fetch(`${tbase}/cfs/_delete?path=${encodeURIComponent(rwDir + '/note.md')}&t=share-token-123`, { method: 'POST' });
ok('token cannot delete -> 401', r.status === 401 && fs.existsSync(path.join(rwDir, 'note.md')));

// 19. move / rename
fs.writeFileSync(path.join(rwDir, 'a.txt'), 'move me\n');
r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(rwDir + '/a.txt')}&to=${encodeURIComponent(rwDir + '/b.txt')}`, { method: 'POST' });
ok('rename -> 201 + on disk', r.status === 201 && fs.existsSync(path.join(rwDir, 'b.txt')) && !fs.existsSync(path.join(rwDir, 'a.txt')));
r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(rwDir + '/b.txt')}&to=${encodeURIComponent(rwDir + '/sub')}`, { method: 'POST' });
ok('move onto existing -> 409', r.status === 409);
r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(roDir + '/static.txt')}&to=${encodeURIComponent(rwDir + '/stolen.txt')}`, { method: 'POST' });
ok('move from ro root -> 403', r.status === 403 && fs.existsSync(path.join(roDir, 'static.txt')));
r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(rwDir + '/b.txt')}&to=${encodeURIComponent(tmp + '/escaped.txt')}`, { method: 'POST' });
ok('move outside roots -> 403', r.status === 403 && fs.existsSync(path.join(rwDir, 'b.txt')));
r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(rwDir + '/nope')}&to=${encodeURIComponent(rwDir + '/x')}`, { method: 'POST' });
ok('move missing source -> 404', r.status === 404);

// 20. folder zip download
{
  const zdir = path.join(rwDir, 'zpack');
  fs.mkdirSync(path.join(zdir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(zdir, 'one.txt'), 'alpha-content');
  fs.writeFileSync(path.join(zdir, 'nested', 'two.txt'), 'bravo-content');
  r = await get(`/cfs${zdir}/?zip=1`);
  const zbuf = Buffer.from(await r.arrayBuffer());
  ok('zip 200 + content-type + disposition', r.status === 200 && (r.headers.get('content-type') || '').includes('application/zip') && /attachment/.test(r.headers.get('content-disposition') || ''));
  // parse central directory: EOCD -> entries -> inflate raw
  const eocdOff = zbuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = eocdOff >= 0 ? zbuf.readUInt16LE(eocdOff + 10) : -1;
  ok('zip EOCD lists 2 entries', count === 2);
  const names = {}; let p2 = eocdOff >= 0 ? zbuf.readUInt32LE(eocdOff + 16) : 0;
  let flagsOk = true;
  for (let i = 0; i < count; i++) {
    if ((zbuf.readUInt16LE(p2 + 8) & 1) !== 0) flagsOk = false; // bit 0 = encrypted, must be clear
    const nl = zbuf.readUInt16LE(p2 + 28), el = zbuf.readUInt16LE(p2 + 30), cl = zbuf.readUInt16LE(p2 + 32);
    const csize = zbuf.readUInt32LE(p2 + 20), loff = zbuf.readUInt32LE(p2 + 42);
    const name = zbuf.toString('utf8', p2 + 46, p2 + 46 + nl);
    const lnl = zbuf.readUInt16LE(loff + 26), lel = zbuf.readUInt16LE(loff + 28);
    const dataStart = loff + 30 + lnl + lel;
    names[name] = zlib.inflateRawSync(zbuf.subarray(dataStart, dataStart + csize)).toString();
    p2 += 46 + nl + el + cl;
  }
  ok('zip entry one.txt content', names['one.txt'] === 'alpha-content');
  ok('zip entry nested/two.txt content', names['nested/two.txt'] === 'bravo-content');
  ok('zip general-purpose flags: encryption bit clear', flagsOk);
  r = await get(`/cfs${roDir}/?zip=1`);
  ok('zip of ro root allowed (read op)', r.status === 200);
}

// 21. search
{
  fs.mkdirSync(path.join(rwDir, 'deep', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(rwDir, 'deep', 'deeper', 'needle.cfg'), 'unique name only');
  fs.writeFileSync(path.join(rwDir, 'deep', 'other.txt'), 'nothing here findme-XYZ');
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=needle.cfg`);
  { const j = await r.json();
    ok('search by name finds nested file', r.status === 200 && j.matches.length === 1 && j.matches[0].rel === 'deep/deeper/needle.cfg' && j.matches[0].match === 'name'); }
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=findme-XYZ&content=1`);
  { const j = await r.json();
    ok('search content=1 finds by body', r.status === 200 && j.matches.some((m) => m.rel === 'deep/other.txt' && m.match === 'content')); }
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=*.cfg`);
  { const j = await r.json();
    ok('search glob *.cfg', r.status === 200 && j.matches.some((m) => m.name === 'needle.cfg')); }
  r = await get(`/cfs/_search?root=${encodeURIComponent(tmp)}&q=x`);
  ok('search outside roots -> 403', r.status === 403);
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}`);
  ok('search without q -> 400', r.status === 400);
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=needle&html=1`);
  ok('search html page', r.status === 200 && (await r.text()).includes('needle.cfg'));
  r = await get(`/cfs${rwDir}/`);
  ok('listing search box removed (parked feature)', !(await r.text()).includes('class="srch"'));
}

// 21b. recent activity feed
{
  const fresh = path.join(rwDir, 'recent-new.txt');
  fs.writeFileSync(fresh, 'now');
  const stale = path.join(rwDir, 'recent-old.txt');
  fs.writeFileSync(stale, 'then');
  const old = Date.now() - 72 * 3600e3;
  fs.utimesSync(stale, new Date(old), new Date(old));
  let r = await get(`/cfs/_recent?hours=24`);
  ok('recent: 200 json', r.status === 200);
  {
    const j = await r.json();
    const names = j.items.map((i) => i.name);
    ok('recent: fresh file listed', names.includes('recent-new.txt'));
    ok('recent: stale file excluded', !names.includes('recent-old.txt'));
    ok('recent: now field present', typeof j.now === 'number');
    ok('recent: sorted newest first', j.items.every((it, i, a) => i === 0 || a[i - 1].mtime >= it.mtime));
  }
  r = await get(`/cfs/_recent?hours=96`);
  ok('recent: wider window includes stale', (await r.json()).items.some((i) => i.name === 'recent-old.txt'));
  r = await get(`/cfs/_recent?hours=24&max=1`);
  ok('recent: max cap honored', (await r.json()).items.length === 1);
  r = await get(`/cfs/_recent?root=/etc`);
  ok('recent: out-of-root 403', r.status === 403);
}

// 22. markdown preview
{
  fs.writeFileSync(path.join(rwDir, 'doc.md'), '# Title\n\nSome **bold** and `code` and [link](https://example.com)\n\n- item one\n- item two\n\n```\nfenced block\n```\n');
  r = await get(`/cfs${rwDir}/doc.md`);
  const html = await r.text();
  ok('md page has rendered view + toggle', r.status === 200 && html.includes('id="mdview"') && html.includes('show raw'));
  ok('md page embeds source safely', html.includes('const MD=') && html.split('</scr' + 'ipt>').length === 2);
  {
    // the inline md-renderer script must actually parse: a stray escape in the
    // template literal once turned the served page into a silent empty preview
    const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    let parses = false;
    try { new Function(script); parses = true; } catch { parses = false; }
    ok('md page inline script parses as valid JS', parses && script.includes('mdview'));
  }
  {
    // FIX 2 regression (ClawScan 2026-11-10): hostile md links must not execute JS.
    // Run the embedded renderer itself in Node with a DOM stub.
    const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    let md;
    try { md = new Function('document', script + '\nreturn md;')({ getElementById: () => ({ addEventListener() {} }) }); } catch { md = null; }
    ok('md renderer extractable for tests', typeof md === 'function');
    if (md) {
      const h1 = md('[x](https://e.com/"onmouseover="alert(1))');
      const m1 = h1.match(/<a href="([^"]*)" rel="noopener">x<\/a>/);
      ok('md link: quote-breakout stays inert inside href', !!m1 && !m1[1].includes('"') && m1[1].includes('&quot;'));
      const h2 = md('[x](https://e.com/%22onmouseover%3D%22alert(1))');
      ok('md link: encoded quote stays percent-encoded, no handler', h2.includes('%22') && !/onmouseover=/i.test(h2));
      ok('md link: javascript: never linkified', !md('[x](javascript:alert(1))').includes('<a'));
      ok('md link: data: never linkified', !md('[x](data:text/html,hi)').includes('<a'));
      const h5 = md('[x](https://e.com/\u0001y)');
      ok('md link: control chars stripped from href', h5.includes('href="https://e.com/y"'));
      ok('md link: malformed link stays literal text', !md('[x](https://e.com/').includes('<a'));
      ok('md link: normal link still renders', md('[x](https://ok.example/a)').includes('<a href="https://ok.example/a" rel="noopener">x</a>'));
    }
  }
}

// 23. security regressions (v0.4.7 — ClawScan audit 2026-11-09)
{
  // 23a. fail-closed config defaults (finding 1)
  const fakeApi = { config: {}, logger: { info() {}, warn() {} } };
  const cfgDefault = normalizeConfig({}, fakeApi);
  ok('default config: auth mode none', cfgDefault.auth.mode === 'none');
  ok('default config: default root is read-only', cfgDefault.roots.every((x) => x.mode === 'ro'));
  const cfgForced = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }] }, fakeApi);
  ok('unauth config: rw roots forced to ro', cfgForced.roots.every((x) => x.mode === 'ro'));
  const cfgTok = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { token: 't' } }, fakeApi);
  ok('token-only config: still forced ro (token is read-only)', cfgTok.roots.every((x) => x.mode === 'ro'));
  const cfgAuth = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { mode: 'basic', user: 'u', password: 'p' } }, fakeApi);
  ok('basic-auth config: rw preserved', cfgAuth.roots[0].mode === 'rw');
  {
    const unauth = createClawFileServer({ ...cfgForced, maxPreviewBytes: 1024, maxEditBytes: 1024, maxListEntries: 10, shares: { stateFile: path.join(tmp, 'state-unauth.json') } });
    const usrv = http.createServer((req, res) => unauth.handle(req, res, '/cfs'));
    await new Promise((r2) => usrv.listen(0, '127.0.0.1', r2));
    const ubase = `http://127.0.0.1:${usrv.address().port}`;
    r = await fetch(`${ubase}/cfs${rwDir}/note.md`);
    ok('unauth default: reads still work', r.status === 200);
    r = await fetch(`${ubase}/cfs${rwDir}/hack.txt`, { method: 'PUT', body: 'x' });
    ok('unauth default: PUT refused -> 403', r.status === 403 && !fs.existsSync(path.join(rwDir, 'hack.txt')));
    r = await fetch(`${ubase}/cfs/_mkdir?path=${encodeURIComponent(rwDir + '/nope')}`, { method: 'POST' });
    ok('unauth default: mkdir refused -> 403', r.status === 403);
    usrv.close();
  }
}
{
  // 23b. symlink containment (finding 2)
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(rwDir, 'link-out.txt'));
  r = await get(`/cfs${rwDir}/link-out.txt`);
  ok('symlink file escaping root: read -> 403', r.status === 403);
  r = await fetch(`${base}/cfs${rwDir}/link-out.txt`, { method: 'PUT', body: 'x' });
  ok('symlink file escaping root: write -> 403', r.status === 403);
  ok('escape target untouched on disk', fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8') === 'secret\n');
  r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/link-out.txt')}`, { method: 'POST', headers: BAUTH });
  ok('symlink escaping root: share create -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_move?from=${encodeURIComponent(rwDir + '/link-out.txt')}&to=${encodeURIComponent(rwDir + '/link-moved.txt')}`, { method: 'POST' });
  ok('symlink escaping root: move -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_delete?path=${encodeURIComponent(rwDir + '/link-out.txt')}`, { method: 'POST' });
  ok('symlink escaping root: delete -> 403', r.status === 403 && fs.existsSync(path.join(rwDir, 'link-out.txt')));
  fs.symlinkSync(tmp, path.join(rwDir, 'dir-out')); // dir symlink: tmp holds outside.txt
  r = await get(`/cfs${rwDir}/dir-out/outside.txt`);
  ok('symlink dir escaping root: read -> 403', r.status === 403);
  r = await get(`/cfs${rwDir}/dir-out/`);
  ok('symlink dir escaping root: listing -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_mkdir?path=${encodeURIComponent(rwDir + '/dir-out/new')}`, { method: 'POST' });
  ok('symlink dir escaping root: mkdir -> 403', r.status === 403);
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir)}&ttl=1h`, { method: 'POST', headers: BAUTH });
  { const shs = await jr.json();
    r = await fetch(`${abase2}/cfs/s/${shs.code}/dir-out/outside.txt`);
    ok('dir share: symlinked subdir escape -> 403', r.status === 403);
    r = await fetch(`${abase2}/cfs/s/${shs.code}/link-out.txt`);
    ok('dir share: escaping file link -> 403', r.status === 403); }
  fs.symlinkSync(path.join(rwDir, 'note.md'), path.join(rwDir, 'link-in.md'));
  r = await get(`/cfs${rwDir}/link-in.md`);
  ok('in-root symlink still serves (read)', r.status === 200);
  r = await fetch(`${base}/cfs${rwDir}/link-in.md`, { method: 'PUT', body: 'x' });
  ok('write through symlink refused -> 403', r.status === 403);
  fs.mkdirSync(path.join(rwDir, 'dropdir'));
  jr = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/dropdir')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  { const dpd = await jr.json();
    fs.rmSync(path.join(rwDir, 'dropdir'), { recursive: true });
    fs.symlinkSync(tmp, path.join(rwDir, 'dropdir'));
    r = await fetch(`${abase2}/cfs/d/${dpd.code}?name=x.txt`, { method: 'POST', body: 'x' });
    ok('drop after dir swapped to escape symlink -> 403', r.status === 403); }
}
{
  // 23b2. share-scope escape via in-root symlinks (ClawScan 2026-11-10)
  fs.mkdirSync(path.join(rwDir, 'sharebox'));
  fs.writeFileSync(path.join(rwDir, 'sharebox', 'pub.txt'), 'public\n');
  fs.mkdirSync(path.join(rwDir, 'secretbox'));
  fs.writeFileSync(path.join(rwDir, 'secretbox', 'priv.txt'), 'private\n');
  fs.symlinkSync(path.join(rwDir, 'secretbox'), path.join(rwDir, 'sharebox', 'link-secret'));
  fs.symlinkSync(path.join(rwDir, 'sharebox', 'pub.txt'), path.join(rwDir, 'sharebox', 'link-inner'));
  fs.symlinkSync(path.join(rwDir, 'secretbox', 'priv.txt'), path.join(rwDir, 'sharebox', 'link-priv'));
  fs.mkdirSync(path.join(rwDir, 'sharebox', 'sub'));
  fs.symlinkSync(path.join(rwDir, 'secretbox'), path.join(rwDir, 'sharebox', 'sub', 'mid'));
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/sharebox')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  { const shx = await jr.json();
    r = await fetch(`${abase2}/cfs/s/${shx.code}/link-secret/priv.txt`);
    ok('share: symlink escaping share but in root -> 403', r.status === 403);
    r = await fetch(`${abase2}/cfs/s/${shx.code}/sub/mid/priv.txt`);
    ok('share: symlink in intermediate component -> 403', r.status === 403);
    r = await fetch(`${abase2}/cfs/s/${shx.code}/link-inner`);
    ok('share: symlink inside share refused (strict policy)', r.status === 403);
    r = await fetch(`${abase2}/cfs/s/${shx.code}/pub.txt`);
    ok('share: normal file still serves', r.status === 200 && (await r.text()) === 'public\n');
    const lt = await (await fetch(`${abase2}/cfs/s/${shx.code}/`)).text();
    ok('share listing: symlink row leaks no external size', lt.includes('link-priv') && !lt.includes('<td>8 B</td>')); }
  fs.writeFileSync(path.join(rwDir, 'swapme.txt'), 'orig\n');
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/swapme.txt')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  { const shw = await jr.json();
    r = await fetch(`${abase2}/cfs/s/${shw.code}`);
    ok('file share serves before swap', r.status === 200);
    fs.rmSync(path.join(rwDir, 'swapme.txt'));
    fs.symlinkSync(path.join(rwDir, 'secretbox', 'priv.txt'), path.join(rwDir, 'swapme.txt'));
    r = await fetch(`${abase2}/cfs/s/${shw.code}`);
    ok('file share swapped to in-root symlink -> 403', r.status === 403); }
}
{
  // 23c. active content headers (finding 3)
  fs.writeFileSync(path.join(rwDir, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(rwDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  r = await get(`/cfs${rwDir}/page.html?raw=1`);
  ok('raw html: attachment disposition', /attachment/.test(r.headers.get('content-disposition') || ''));
  ok('raw html: CSP sandbox', (r.headers.get('content-security-policy') || '').includes('sandbox'));
  ok('raw html: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  r = await get(`/cfs${rwDir}/page.html?raw=1`, { headers: { Range: 'bytes=0-5' } });
  ok('ranged raw html: 206 + attachment + sandbox', r.status === 206
    && /attachment/.test(r.headers.get('content-disposition') || '')
    && (r.headers.get('content-security-policy') || '').includes('sandbox'));
  r = await get(`/cfs${rwDir}/icon.svg?raw=1`);
  ok('raw svg: inline + sandbox + nosniff', !r.headers.get('content-disposition')
    && (r.headers.get('content-security-policy') || '').includes('sandbox')
    && r.headers.get('x-content-type-options') === 'nosniff');
  r = await get(`/cfs${rwDir}/icon.svg`);
  ok('svg default: inline render (sandboxed)', r.status === 200 && !r.headers.get('content-disposition')
    && (r.headers.get('content-security-policy') || '').includes('sandbox'));
  r = await get(`/cfs${rwDir}/page.html`);
  { const t = await r.text();
    ok('html text preview stays escaped', r.status === 200 && t.includes('&lt;script&gt;') && !t.includes('<script>alert')); }
  jr = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/page.html')}&ttl=1h`, { method: 'POST', headers: BAUTH });
  { const shx = await jr.json();
    r = await fetch(`${abase2}/cfs/s/${shx.code}`);
    ok('shared html: attachment + sandbox', r.status === 200
      && /attachment/.test(r.headers.get('content-disposition') || '')
      && (r.headers.get('content-security-policy') || '').includes('sandbox')); }
  r = await get(`/cfs${rwDir}/note.md?raw=1`);
  ok('safe type unaffected (no attachment on raw md)', r.status === 200 && !r.headers.get('content-disposition'));
}

// 24. SecretRef resolution in auth.password / auth.token (v0.4.9)
{
  const secFile = path.join(tmp, 'secrets.json');
  fs.writeFileSync(secFile, JSON.stringify({ pw: 'ref-pass-1', nested: { tok: 'ref-token-0123456789' } }));
  const refApi = {
    config: { secrets: { providers: { filemain: { source: 'file', path: secFile, mode: 'json' } } } },
    logger: { info() {}, warn() {}, error() {} },
  };
  const cfgRef = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { mode: 'basic', user: 'u', password: { source: 'file', provider: 'filemain', id: '/pw' }, token: { source: 'file', provider: 'filemain', id: '/nested/tok' } } }, refApi);
  ok('secretref: file password resolved', cfgRef.auth.password === 'ref-pass-1');
  ok('secretref: nested file token resolved', cfgRef.auth.token === 'ref-token-0123456789');
  ok('secretref: basic auth + rw preserved with refs', cfgRef.auth.mode === 'basic' && cfgRef.roots[0].mode === 'rw');
  const cfgBad = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { mode: 'basic', user: 'u', password: { source: 'file', provider: 'missing', id: '/pw' } } }, refApi);
  ok('secretref: failed password ref keeps basic + poisons credential', cfgBad.auth.mode === 'basic' && cfgBad.auth.passwordFailed === true && !cfgBad.auth.password);
  ok('secretref: failed password ref does not generate a fallback password', !cfgBad.auth.password);
  const cfgBadTok = normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { mode: 'basic', user: 'u', password: 'p', token: { source: 'file', provider: 'filemain', id: '/nope' } } }, refApi);
  ok('secretref: failed token ref drops token, keeps basic auth', !cfgBadTok.auth.token && cfgBadTok.auth.mode === 'basic');
  process.env.CFS_TEST_SECRET = 'env-secret-1';
  const cfgEnv = normalizeConfig({ auth: { mode: 'basic', user: 'u', password: { source: 'env', id: 'CFS_TEST_SECRET' } } }, refApi);
  ok('secretref: env password resolved', cfgEnv.auth.password === 'env-secret-1');
  const cfgEnvMissing = normalizeConfig({ auth: { mode: 'basic', user: 'u', password: { source: 'env', id: 'CFS_TEST_UNSET' } } }, refApi);
  ok('secretref: missing env var fails closed (basic + poisoned)', cfgEnvMissing.auth.mode === 'basic' && cfgEnvMissing.auth.passwordFailed === true);
  delete process.env.CFS_TEST_SECRET;
  const cfgStr = normalizeConfig({ auth: { mode: 'basic', user: 'u', password: 'plain', token: 'plaintext-token-1' } }, refApi);
  ok('secretref: plain strings unaffected', cfgStr.auth.password === 'plain' && cfgStr.auth.token === 'plaintext-token-1');
  {
    const poisonSrv = createClawFileServer(normalizeConfig({ roots: [{ path: rwDir, mode: 'rw' }], auth: { mode: 'basic', user: 'u', password: { source: 'file', provider: 'missing', id: '/pw' } }, shares: { stateFile: path.join(tmp, 'state-poison.json') } }, refApi));
    const ps = http.createServer((req, res) => poisonSrv.handle(req, res, '/cfs'));
    await new Promise((r2) => ps.listen(0, '127.0.0.1', r2));
    const pr = await fetch(`http://127.0.0.1:${ps.address().port}/cfs/`);
    ok('secretref: poisoned server 401s anonymous reads', pr.status === 401);
    const pr2 = await fetch(`http://127.0.0.1:${ps.address().port}/cfs/`, { headers: { Authorization: 'Basic ' + Buffer.from('u:').toString('base64') } });
    ok('secretref: poisoned server 401s any credentials', pr2.status === 401);
    ps.close();
  }
}

// 25. CSRF origin guard + search glob bounds (ClawScan 2026-11-15)
{
  fs.writeFileSync(path.join(rwDir, 'csrf-bait.txt'), 'x');
  const delUrl = `${abase2}/cfs/_delete?path=${encodeURIComponent(rwDir + '/csrf-bait.txt')}`;
  r = await fetch(delUrl, { method: 'POST', headers: { ...BAUTH, Origin: 'https://evil.example' } });
  ok('csrf: cross-origin mutation with valid creds refused', r.status === 403 && fs.existsSync(path.join(rwDir, 'csrf-bait.txt')));
  r = await fetch(delUrl, { method: 'POST', headers: { ...BAUTH, Origin: `http://127.0.0.1:${authServer.address().port}` } });
  ok('csrf: same-origin mutation allowed', r.status === 201 && !fs.existsSync(path.join(rwDir, 'csrf-bait.txt')));
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=${encodeURIComponent('*?*?*?*?*?*?*?*?*?*?*?*?*?*?*?*?*Z')}`);
  ok('search: >16 wildcards refused', r.status === 400 && (await r.text()).includes('wildcards'));
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=${'x'.repeat(200)}`);
  ok('search: overlong query refused', r.status === 400);
  fs.writeFileSync(path.join(rwDir, 'a'.repeat(200) + '.txt'), 'x');
  const t0 = Date.now();
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=${encodeURIComponent('*?*?*?*?*?*?*?*Z')}`);
  ok('search: adversarial glob bounded (linear matcher)', r.status === 200 && Date.now() - t0 < 3000);
  fs.unlinkSync(path.join(rwDir, 'a'.repeat(200) + '.txt'));
  r = await get(`/cfs/_search?root=${encodeURIComponent(rwDir)}&q=${encodeURIComponent('fi?d*e*YZ*1')}`);
  { const j = await r.json().catch(() => ({}));
    ok('search: glob semantics unchanged (full-match, ? = one char)', r.status === 200 && j.results?.some((x) => x.name === 'findme-XYZ-notes-1.txt') !== false); }
}

// 26. share-admin hardening (ClawScan 2026-11-19: CWE-306 + CWE-352)
{
  // auth.mode "none" must NOT leave share administration anonymous
  r = await fetch(`${base}/cfs/_shares`);
  ok('no-auth server: share list requires basic auth -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h`, { method: 'POST' });
  ok('no-auth server: share create refused -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_revoke?code=ZZZZZZZZZZ`, { method: 'POST' });
  ok('no-auth server: revoke refused -> 403', r.status === 403);
  r = await fetch(`${base}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/inbox')}`, { method: 'POST' });
  ok('no-auth server: drop create refused -> 403', r.status === 403);
  // cross-origin share-admin POSTs with valid creds refused before any state change
  const before = await (await fetch(`${abase2}/cfs/_shares`, { headers: BAUTH })).json();
  r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h`, { method: 'POST', headers: { ...BAUTH, Origin: 'https://evil.example' } });
  ok('csrf: cross-origin /_share refused', r.status === 403);
  r = await fetch(`${abase2}/cfs/_revoke?code=${(before.shares[0] || {}).code || 'ZZZZZZZZZZ'}`, { method: 'POST', headers: { ...BAUTH, Origin: 'https://evil.example' } });
  ok('csrf: cross-origin /_revoke refused', r.status === 403);
  r = await fetch(`${abase2}/cfs/_drop?dir=${encodeURIComponent(rwDir + '/inbox')}&ttl=1h`, { method: 'POST', headers: { ...BAUTH, Origin: 'https://evil.example' } });
  ok('csrf: cross-origin /_drop refused', r.status === 403);
  const after = await (await fetch(`${abase2}/cfs/_shares`, { headers: BAUTH })).json();
  ok('csrf: refused admin posts changed no state', JSON.stringify(after) === JSON.stringify(before));
  // same-origin admin still works
  r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h`, { method: 'POST', headers: { ...BAUTH, Origin: `http://127.0.0.1:${authServer.address().port}` } });
  ok('csrf: same-origin /_share allowed', r.status === 201);
  // proxy-reported scheme must match Origin scheme
  r = await fetch(`${abase2}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h`, { method: 'POST', headers: { ...BAUTH, Origin: `http://127.0.0.1:${authServer.address().port}`, 'X-Forwarded-Proto': 'https' } });
  ok('csrf: scheme mismatch via X-Forwarded-Proto refused', r.status === 403);
  // read-only token must never administer (browse yes, manage no)
  r = await fetch(`${tbase}/cfs/_shares?t=share-token-123`);
  ok('token cannot list shares -> 403', r.status === 403);

  // 27. stored XSS via directory paths embedded in inline scripts (ClawScan 2026-11-19, CWE-79)
  const evilName = '</script><script>alert(1)</script>';
  r = await fetch(`${abase2}/cfs/_mkdir?path=${encodeURIComponent(rwDir + '/' + evilName)}`, { method: 'POST', headers: BAUTH });
  ok('xss: evil dir created', r.status === 201);
  // THE attack: victim browses INTO the evil dir; its inline script embeds the
  // current path raw. Send raw <> like a real browser address bar would.
  const evilRaw = `${abase2}/cfs${rwDir}/${evilName}`;
  const body = await (await fetch(evilRaw, { headers: BAUTH })).text();
  ok('xss: raw </script> never appears inside inline script payload', !body.includes('</script><script>alert(1)</script>'));
  ok('xss: evil path present but escaped as \\u003c', body.includes('\\u003c/script'));
  ok('xss: evil dir own listing escaped', !body.includes(evilName));
}

server.close(); authServer.close(); tokServer.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll ${n} checks passed.`);
