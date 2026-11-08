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
});
server._cfsAuth = createClawFileServer({
  roots: [{ path: rwDir, mode: 'rw', label: 'RW' }],
  auth: { mode: 'basic', user: 'u', password: 'p' },
  maxPreviewBytes: 1024 * 1024, maxEditBytes: 512 * 1024, maxListEntries: 100,
});
server._cfsTok = createClawFileServer({
  roots: [{ path: rwDir, mode: 'rw', label: 'RW' }],
  auth: { mode: 'basic', user: 'u', password: 'p', token: 'share-token-123' },
  maxPreviewBytes: 1024 * 1024, maxEditBytes: 512 * 1024, maxListEntries: 100,
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

server.close(); authServer.close(); tokServer.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll ${n} checks passed.`);
