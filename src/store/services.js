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

const DEFAULT_OVERVIEW_WIDGETS = [
  { id: 'kpis', label: 'System-KPIs (CPU, RAM, Netz, Pool)', visible: true },
  { id: 'telemetry', label: 'Echtzeit-Telemetrie (Verlauf)', visible: true },
  { id: 'media', label: 'Medien-Verteilung', visible: true },
  { id: 'disks', label: 'Festplatten-Kurzstatus', visible: true },
  { id: 'services', label: 'Homeserver-Apps (Schnellzugriff)', visible: true },
  { id: 'docker', label: 'Container-Kurzstatus', visible: true }
];

function normalizeUiConfig(rawUi) {
  const ui = rawUi && typeof rawUi === 'object' ? rawUi : {};
  const validThemes = new Set(['dark', 'light', 'studio-dark', 'studio-light', 'oled', 'slate', 'indigo']);
  const validAccents = new Set(['amber', 'blue', 'emerald', 'purple', 'red']);
  const theme = validThemes.has(ui.theme) ? ui.theme : 'studio-dark';
  const accent = validAccents.has(ui.accent) ? ui.accent : 'blue';

  let widgets = DEFAULT_OVERVIEW_WIDGETS.map((w) => ({ ...w }));
  if (Array.isArray(ui.overviewWidgets) && ui.overviewWidgets.length > 0) {
    const allowedIds = new Set(DEFAULT_OVERVIEW_WIDGETS.map((w) => w.id));
    const seen = new Set();
    const cleaned = [];
    for (const item of ui.overviewWidgets) {
      if (item && allowedIds.has(item.id) && !seen.has(item.id)) {
        seen.add(item.id);
        const def = DEFAULT_OVERVIEW_WIDGETS.find((d) => d.id === item.id);
        cleaned.push({ id: item.id, label: def.label, visible: item.visible !== false });
      }
    }
    for (const def of DEFAULT_OVERVIEW_WIDGETS) {
      if (!seen.has(def.id)) cleaned.push({ ...def });
    }
    widgets = cleaned;
  }

  return { theme, accent, overviewWidgets: widgets };
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
      portainerEndpointId: process.env.PORTAINER_ENDPOINT_ID ? Number(process.env.PORTAINER_ENDPOINT_ID) : null,
      ui: normalizeUiConfig(parsed.ui)
    };
  } catch {
    return {
      serverName: 'Linux Homeserver',
      services: [],
      diskLabels: {},
      mediaPaths: [],
      portainerUrl: process.env.PORTAINER_URL || '',
      portainerApiKey: process.env.PORTAINER_API_KEY || '',
      portainerEndpointId: process.env.PORTAINER_ENDPOINT_ID ? Number(process.env.PORTAINER_ENDPOINT_ID) : null,
      ui: normalizeUiConfig(null)
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
        : defaults.portainerEndpointId,
      ui: normalizeUiConfig(parsed.ui)
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
    hasPortainerApiKey: Boolean(cfg.portainerApiKey),
    ui: cfg.ui
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

  const mergedUi = nextConfig.ui && typeof nextConfig.ui === 'object'
    ? normalizeUiConfig({ ...current.ui, ...nextConfig.ui })
    : current.ui;

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
      : current.portainerEndpointId,
    ui: mergedUi
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return getPublicConfig();
}

module.exports = {
  loadConfig,
  getPublicConfig,
  saveConfig
};
