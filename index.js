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
  },
});
