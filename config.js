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

export function normalizeConfig(pluginConfig, api) {
  const c = pluginConfig || {};
  const basePath = (c.basePath || '/clawfileserver').replace(/\/+$/, '');
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  // Fail closed: the default root is READ-ONLY. Writes require an explicit
  // rw root AND configured auth (see force-ro below).
  let roots = Array.isArray(c.roots) && c.roots.length > 0
    ? c.roots
    : [{ path: c.workspace || api.config?.agents?.defaults?.workspace || defaultWorkspace(), mode: 'ro' }];
  let auth = { mode: 'none', ...(c.auth || {}) };
  if (auth.mode === 'basic' && (!auth.user || !auth.password)) {
    auth = { ...auth, user: auth.user || 'admin' };
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
