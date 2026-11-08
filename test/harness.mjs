// Standalone test harness: mounts core.js behind a plain node:http server on
// an ephemeral port and exercises every route. No OpenClaw runtime needed.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createClawFileServer } from '../core.js';

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
r = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(tmp + '/outside.txt')}`, { method: 'POST' });
ok('share outside roots -> 403', r.status === 403);
r = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir + '/missing')}`, { method: 'POST' });
ok('share missing file -> 404', r.status === 404);
r = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=99x`, { method: 'POST' });
ok('bad ttl -> 400', r.status === 400);
{ // max downloads: HEAD free, first GET ok, second 410
  jr = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1h&max=1`, { method: 'POST' });
  const sh1 = await jr.json();
  await fetch(`${base}/cfs/s/${sh1.code}`, { method: 'HEAD' });
  r = await fetch(`${base}/cfs/s/${sh1.code}`);
  ok('share max=1 first GET ok', r.status === 200);
  r = await fetch(`${base}/cfs/s/${sh1.code}`);
  ok('share exhausted -> 410', r.status === 410);
  r = await fetch(`${base}/cfs/_revoke?code=${sh1.code}`, { method: 'POST' });
  ok('revoke -> ok', r.status === 200);
}
r = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir + '/note.md')}&ttl=1s`, { method: 'POST' });
{ const sh2 = await r.json();
  await new Promise((res2) => setTimeout(res2, 1200));
  r = await fetch(`${base}/cfs/s/${sh2.code}`);
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
  jr = await fetch(`${base}/cfs/_share?path=${encodeURIComponent(rwDir)}&ttl=1h`, { method: 'POST' });
  const shd = await jr.json();
  r = await fetch(`${base}/cfs/s/${shd.code}/`);
  ok('dir share listing', r.status === 200 && (await r.text()).includes('note.md'));
  r = await fetch(`${base}/cfs/s/${shd.code}/note.md`);
  ok('dir share file fetch', r.status === 200);
  r = await fetch(`${base}/cfs/s/${shd.code}/../outside.txt`);
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

server.close(); authServer.close(); tokServer.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll ${n} checks passed.`);
