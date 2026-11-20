// ClawFileServer — OpenClaw plugin entry.
// Mounts a file browser / preview / editor HTTP route on the Gateway port.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createClawFileServer } from './core.js';
import { normalizeConfig } from './config.js';

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
    // ClawScan 2026-11-20 (CWE-306): make the security posture loud at startup.
    if (cfg.auth.mode === 'locked') {
      api.logger.warn?.(
        'clawfileserver: LOCKED — no auth configured; every request is refused. ' +
        'Set auth.mode="basic" (with user+password) to serve with login, or auth.mode="none" to explicitly allow anonymous read-only.',
      );
    } else if (cfg.auth.mode === 'none') {
      api.logger.warn?.(
        `clawfileserver: anonymous read-only access ENABLED (auth.mode="none") for ${cfg.roots.length} root(s) — ` +
        `anyone who can reach ${cfg.basePath}/ can read these files. Set auth.mode="basic" to require login.`,
      );
    }
  },
});
