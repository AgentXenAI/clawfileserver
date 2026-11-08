// ClawFileServer — OpenClaw plugin entry.
// Mounts a file browser / preview / editor HTTP route on the Gateway port.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import os from 'node:os';
import { createClawFileServer } from './core.js';

function normalizeConfig(pluginConfig, api) {
  const c = pluginConfig || {};
  const basePath = (c.basePath || '/clawfileserver').replace(/\/+$/, '');
  let roots = Array.isArray(c.roots) && c.roots.length > 0
    ? c.roots
    : [{ path: api.config?.agents?.defaults?.workspace || process.cwd(), mode: 'rw' }];
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
  return {
    basePath,
    roots,
    auth,
    maxPreviewBytes: c.maxPreviewBytes ?? 1024 * 1024,
    maxEditBytes: c.maxEditBytes ?? 512 * 1024,
    maxListEntries: c.maxListEntries ?? 5000,
    showHidden: c.showHidden ?? false,
    logger: api.logger,
  };
}

function cryptoRandom() {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default definePluginEntry({
  id: 'clawfileserver',
  name: 'ClawFileServer',
  description: 'Browse, preview, and edit files over HTTP on the Gateway port',
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig, api);
    const server = createClawFileServer(cfg);
    api.registerHttpRoute({
      path: cfg.basePath,
      auth: 'plugin',
      match: 'prefix',
      handler: async (req, res) => server.handle(req, res, cfg.basePath),
    });
    api.logger.info(
      `clawfileserver: serving ${cfg.roots.length} root(s) at ${cfg.basePath}/ ` +
      `(auth: ${cfg.auth.mode}; rw: ${cfg.roots.filter((r) => r.mode === 'rw').length})`,
    );
  },
});
