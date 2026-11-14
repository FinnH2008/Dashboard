const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_FILE = path.join(process.cwd(), 'config', 'default-services.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDefaultConfig() {
  try {
    const raw = fs.readFileSync(DEFAULT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      serverName: parsed.serverName || 'Linux Homeserver',
      services: Array.isArray(parsed.services) ? parsed.services : [],
      diskLabels: parsed.diskLabels || {},
      mediaPaths: Array.isArray(parsed.mediaPaths) ? parsed.mediaPaths : [],
      portainerUrl: process.env.PORTAINER_URL || '',
      portainerApiKey: process.env.PORTAINER_API_KEY || '',
      portainerEndpointId: process.env.PORTAINER_ENDPOINT_ID ? Number(process.env.PORTAINER_ENDPOINT_ID) : null
    };
  } catch {
    return {
      serverName: 'Linux Homeserver',
      services: [],
      diskLabels: {},
      mediaPaths: [],
      portainerUrl: process.env.PORTAINER_URL || '',
      portainerApiKey: process.env.PORTAINER_API_KEY || '',
      portainerEndpointId: process.env.PORTAINER_ENDPOINT_ID ? Number(process.env.PORTAINER_ENDPOINT_ID) : null
    };
  }
}

function loadConfig() {
  ensureDataDir();
  const defaults = readDefaultConfig();
  if (!fs.existsSync(CONFIG_FILE)) {
    if (process.env.SERVER_NAME) {
      defaults.serverName = process.env.SERVER_NAME;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      serverName: process.env.SERVER_NAME || parsed.serverName || defaults.serverName,
      services: Array.isArray(parsed.services) ? parsed.services : defaults.services,
      diskLabels: parsed.diskLabels && typeof parsed.diskLabels === 'object' ? parsed.diskLabels : {},
      mediaPaths: Array.isArray(parsed.mediaPaths) ? parsed.mediaPaths : [],
      portainerUrl: parsed.portainerUrl || defaults.portainerUrl || '',
      portainerApiKey: parsed.portainerApiKey || defaults.portainerApiKey || '',
      portainerEndpointId: Number.isFinite(Number(parsed.portainerEndpointId)) && Number(parsed.portainerEndpointId) > 0
        ? Number(parsed.portainerEndpointId)
        : defaults.portainerEndpointId
    };
  } catch {
    return defaults;
  }
}

function getPublicConfig() {
  const cfg = loadConfig();
  return {
    serverName: cfg.serverName,
    services: cfg.services,
    diskLabels: cfg.diskLabels,
    mediaPaths: cfg.mediaPaths,
    portainerUrl: cfg.portainerUrl || '',
    portainerEndpointId: cfg.portainerEndpointId || null,
    hasPortainerApiKey: Boolean(cfg.portainerApiKey)
  };
}

function saveConfig(nextConfig) {
  ensureDataDir();
  const current = loadConfig();
  let nextApiKey = current.portainerApiKey || '';
  if (nextConfig.clearPortainerApiKey === true) {
    nextApiKey = '';
  } else if (typeof nextConfig.portainerApiKey === 'string' && nextConfig.portainerApiKey.trim()) {
    nextApiKey = nextConfig.portainerApiKey.trim();
  }

  const merged = {
    serverName: typeof nextConfig.serverName === 'string' && nextConfig.serverName.trim()
      ? nextConfig.serverName.trim()
      : current.serverName,
    services: Array.isArray(nextConfig.services) ? nextConfig.services : current.services,
    diskLabels: nextConfig.diskLabels && typeof nextConfig.diskLabels === 'object'
      ? { ...current.diskLabels, ...nextConfig.diskLabels }
      : current.diskLabels,
    mediaPaths: Array.isArray(nextConfig.mediaPaths) ? nextConfig.mediaPaths : current.mediaPaths,
    portainerUrl: typeof nextConfig.portainerUrl === 'string'
      ? nextConfig.portainerUrl.trim().replace(/\/+$/, '')
      : current.portainerUrl || '',
    portainerApiKey: nextApiKey,
    portainerEndpointId: nextConfig.portainerEndpointId !== undefined
      ? (Number(nextConfig.portainerEndpointId) > 0 ? Number(nextConfig.portainerEndpointId) : null)
      : current.portainerEndpointId
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return getPublicConfig();
}

module.exports = {
  loadConfig,
  getPublicConfig,
  saveConfig
};
