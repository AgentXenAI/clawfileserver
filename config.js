// ClawFileServer config normalization — pure function, no OpenClaw imports,
// so the test harness can exercise the fail-closed defaults standalone.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function defaultWorkspace() {
  const state = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  const candidates = [process.env.OPENCLAW_STATE_DIR && path.join(state, 'workspace'), path.join(state, 'workspace')];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return process.cwd();
}

function cryptoRandom() {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Resolve a SecretRef object ({source, provider, id}) to its string value.
// Mirrors OpenClaw core SecretRef semantics for the `file` and `env` sources,
// reading provider definitions from the core config (secrets.providers).
// Plain strings pass through untouched. Returns { ok, value | reason }.
function resolveSecretRef(value, api) {
  if (typeof value === 'string' || value == null) return { ok: true, value };
  if (typeof value !== 'object') return { ok: false, reason: 'must be a string or a {source, provider, id} object' };
  const { source, provider, id } = value;
  if (!source || !id) return { ok: false, reason: 'secret reference requires source and id' };
  if (source === 'env') {
    const v = process.env[id];
    return v ? { ok: true, value: v } : { ok: false, reason: `env var "${id}" is not set` };
  }
  if (source === 'file') {
    const p = api.config?.secrets?.providers?.[provider];
    if (!p || p.source !== 'file' || !p.path) {
      return { ok: false, reason: `file provider "${provider}" not found under secrets.providers` };
    }
    try {
      const raw = fs.readFileSync(p.path, 'utf8');
      let cur;
      if (!p.mode || p.mode === 'json') {
        cur = JSON.parse(raw);
        for (const k of String(id).split('/').filter(Boolean)) {
          if (cur === null || typeof cur !== 'object' || !(k in cur)) throw new Error(`path "${id}" not found in ${p.path}`);
          cur = cur[k];
        }
      } else {
        cur = raw.trim();
      }
      if (typeof cur !== 'string' || !cur) throw new Error(`path "${id}" did not resolve to a non-empty string`);
      return { ok: true, value: cur };
    } catch (e) {
      return { ok: false, reason: `file provider "${provider}" (${p.path}): ${e.message}` };
    }
  }
  return { ok: false, reason: `source "${source}" is not supported here (use "file" or "env")` };
}

export function normalizeConfig(pluginConfig, api) {
  const c = pluginConfig || {};
  const basePath = (c.basePath || '/clawfileserver').replace(/\/+$/, '');
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  // Fail closed: the default root is READ-ONLY. Writes require an explicit
  // rw root AND configured auth (see force-ro below).
  let roots = Array.isArray(c.roots) && c.roots.length > 0
    ? c.roots
    : [{ path: c.workspace || api.config?.agents?.defaults?.workspace || defaultWorkspace(), mode: 'ro' }];
  // ClawScan 2026-11-20 (CWE-306): safe default. With no auth configured the
  // plugin LOCKS and refuses every request with setup instructions — anonymous
  // read-only serving is now an explicit opt-in (auth.mode="none"). Setting
  // user+password without a mode infers "basic" (clear intent).
  let auth;
  if (c.auth && c.auth.mode) auth = { ...c.auth };
  else if (c.auth && c.auth.user && c.auth.password) auth = { mode: 'basic', ...c.auth };
  else auth = { mode: 'locked' };
  // Fail closed on unresolvable secret references: a broken password ref keeps
  // basic mode but poisons the credential (passwordFailed) so EVERY request is
  // refused with 401 until the secret resolves — never a silent downgrade to
  // anonymous read-only serving (ClawScan 2026-11-15, CWE-636). A broken token
  // ref just disables the optional share token.
  for (const field of ['password', 'token']) {
    if (auth[field] && typeof auth[field] === 'object') {
      const r = resolveSecretRef(auth[field], api);
      if (r.ok) auth[field] = r.value;
      else if (field === 'password') {
        api.logger.error?.(`clawfileserver: auth.password secret reference failed — ${r.reason}; refusing all requests until the secret resolves`);
        auth.passwordFailed = true;
        delete auth.password;
      } else {
        api.logger.error?.(`clawfileserver: auth.token secret reference failed — ${r.reason}; share token disabled`);
        delete auth.token;
      }
    }
  }
  if (auth.mode === 'basic' && !auth.passwordFailed && (!auth.user || !auth.password)) {
    auth.user = auth.user || 'admin';
    if (!auth.password) {
      auth.password = cryptoRandom();
      api.logger.info(
        `clawfileserver: generated one-time basic-auth password for user "${auth.user}": ${auth.password} ` +
        '(set plugins.entries.clawfileserver.config.auth.password to fix it)',
      );
    }
  }
  // Fail closed: without basic auth NOTHING is writable. Unauthenticated (or
  // token-only) serving is forced read-only; mutations are refused with 403.
  // The share-token credential is read-only by design and never unlocks writes.
  if (auth.mode !== 'basic') {
    if (roots.some((r) => r.mode === 'rw')) {
      api.logger.warn?.(
        'clawfileserver: auth.mode is not "basic" — all roots forced read-only. ' +
        'Set plugins.entries.clawfileserver.config.auth.mode="basic" (with user+password) to enable writes.',
      );
    }
    roots = roots.map((r) => ({ ...r, mode: 'ro' }));
  }
  return {
    basePath,
    roots,
    auth,
    maxPreviewBytes: c.maxPreviewBytes ?? 1024 * 1024,
    maxEditBytes: c.maxEditBytes ?? 512 * 1024,
    maxPutBytes: c.maxPutBytes ?? 512 * 1024 * 1024,
    maxListEntries: c.maxListEntries ?? 5000,
    maxZipEntries: c.maxZipEntries ?? 2000,
    searchScanLimit: c.searchScanLimit ?? 20000,
    showHidden: c.showHidden ?? false,
    shares: {
      enabled: c.shares?.enabled ?? true,
      stateFile: c.shares?.stateFile || path.join(stateDir, 'clawfileserver', 'shares.json'),
      defaultTtl: c.shares?.defaultTtl || '24h',
      maxTtl: c.shares?.maxTtl || '30d',
      maxUploadBytes: c.shares?.maxUploadBytes ?? 2147483648,
    },
    logger: api.logger,
  };
}
