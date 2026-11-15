const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json');

const DEFAULT_CONFIG = {
  enabled: false,
  cooldownMinutes: 30,
  triggers: {
    smart: true,
    diskFull: true,
    cpuTemp: true,
    diskTemp: true,
    watchdog: true
  },
  channels: {
    ntfy: {
      enabled: false,
      url: 'https://ntfy.sh',
      topic: '',
      token: ''
    },
    discord: {
      enabled: false,
      webhookUrl: ''
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatId: ''
    },
    webhook: {
      enabled: false,
      url: '',
      secret: ''
    }
  },
  history: []
};

const lastSentByKey = new Map();
let lastEvaluateAt = 0;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadNotificationData() {
  ensureDataDir();
  if (!fs.existsSync(NOTIF_FILE)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    return {
      enabled: Boolean(parsed.enabled),
      cooldownMinutes: Math.max(1, Math.min(1440, Number(parsed.cooldownMinutes) || 30)),
      triggers: {
        ...DEFAULT_CONFIG.triggers,
        ...(parsed.triggers && typeof parsed.triggers === 'object' ? parsed.triggers : {})
      },
      channels: {
        ntfy: {
          ...DEFAULT_CONFIG.channels.ntfy,
          ...(parsed.channels?.ntfy || {})
        },
        discord: {
          ...DEFAULT_CONFIG.channels.discord,
          ...(parsed.channels?.discord || {})
        },
        telegram: {
          ...DEFAULT_CONFIG.channels.telegram,
          ...(parsed.channels?.telegram || {})
        },
        webhook: {
          ...DEFAULT_CONFIG.channels.webhook,
          ...(parsed.channels?.webhook || {})
        }
      },
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 40) : []
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveNotificationData(data) {
  ensureDataDir();
  const clean = {
    enabled: Boolean(data.enabled),
    cooldownMinutes: Math.max(1, Math.min(1440, Number(data.cooldownMinutes) || 30)),
    triggers: data.triggers,
    channels: data.channels,
    history: (data.history || []).slice(0, 40)
  };
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(clean, null, 2), { mode: 0o600, encoding: 'utf8' });
  return clean;
}

function getPublicNotificationState() {
  const data = loadNotificationData();
  return {
    enabled: data.enabled,
    cooldownMinutes: data.cooldownMinutes,
    triggers: data.triggers,
    channels: {
      ntfy: {
        enabled: Boolean(data.channels.ntfy.enabled),
        url: data.channels.ntfy.url || 'https://ntfy.sh',
        topic: data.channels.ntfy.topic || '',
        hasToken: Boolean(data.channels.ntfy.token)
      },
      discord: {
        enabled: Boolean(data.channels.discord.enabled),
        hasWebhookUrl: Boolean(data.channels.discord.webhookUrl)
      },
      telegram: {
        enabled: Boolean(data.channels.telegram.enabled),
        chatId: data.channels.telegram.chatId || '',
        hasBotToken: Boolean(data.channels.telegram.botToken)
      },
      webhook: {
        enabled: Boolean(data.channels.webhook.enabled),
        url: data.channels.webhook.url || '',
        hasSecret: Boolean(data.channels.webhook.secret)
      }
    },
    history: data.history || []
  };
}

function saveNotificationConfig(patch = {}) {
  const current = loadNotificationData();
  const nextTriggers = {
    smart: patch.triggers?.smart !== undefined ? Boolean(patch.triggers.smart) : current.triggers.smart,
    diskFull: patch.triggers?.diskFull !== undefined ? Boolean(patch.triggers.diskFull) : current.triggers.diskFull,
    cpuTemp: patch.triggers?.cpuTemp !== undefined ? Boolean(patch.triggers.cpuTemp) : current.triggers.cpuTemp,
    diskTemp: patch.triggers?.diskTemp !== undefined ? Boolean(patch.triggers.diskTemp) : current.triggers.diskTemp,
    watchdog: patch.triggers?.watchdog !== undefined ? Boolean(patch.triggers.watchdog) : current.triggers.watchdog
  };

  const cIn = patch.channels || {};
  const ntfyIn = cIn.ntfy || {};
  const discIn = cIn.discord || {};
  const teleIn = cIn.telegram || {};
  const webhIn = cIn.webhook || {};

  const nextChannels = {
    ntfy: {
      enabled: ntfyIn.enabled !== undefined ? Boolean(ntfyIn.enabled) : current.channels.ntfy.enabled,
      url: typeof ntfyIn.url === 'string' && ntfyIn.url.trim() ? ntfyIn.url.trim().replace(/\/+$/, '') : current.channels.ntfy.url || 'https://ntfy.sh',
      topic: typeof ntfyIn.topic === 'string' ? ntfyIn.topic.trim() : current.channels.ntfy.topic,
      token: ntfyIn.clearToken ? '' : (typeof ntfyIn.token === 'string' && ntfyIn.token.trim() ? ntfyIn.token.trim() : current.channels.ntfy.token)
    },
    discord: {
      enabled: discIn.enabled !== undefined ? Boolean(discIn.enabled) : current.channels.discord.enabled,
      webhookUrl: discIn.clearWebhook ? '' : (typeof discIn.webhookUrl === 'string' && discIn.webhookUrl.trim() ? discIn.webhookUrl.trim() : current.channels.discord.webhookUrl)
    },
    telegram: {
      enabled: teleIn.enabled !== undefined ? Boolean(teleIn.enabled) : current.channels.telegram.enabled,
      chatId: typeof teleIn.chatId === 'string' ? teleIn.chatId.trim() : current.channels.telegram.chatId,
      botToken: teleIn.clearToken ? '' : (typeof teleIn.botToken === 'string' && teleIn.botToken.trim() ? teleIn.botToken.trim() : current.channels.telegram.botToken)
    },
    webhook: {
      enabled: webhIn.enabled !== undefined ? Boolean(webhIn.enabled) : current.channels.webhook.enabled,
      url: typeof webhIn.url === 'string' ? webhIn.url.trim() : current.channels.webhook.url,
      secret: webhIn.clearSecret ? '' : (typeof webhIn.secret === 'string' && webhIn.secret.trim() ? webhIn.secret.trim() : current.channels.webhook.secret)
    }
  };

  saveNotificationData({
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    cooldownMinutes: patch.cooldownMinutes !== undefined ? Math.max(1, Math.min(1440, Number(patch.cooldownMinutes) || 30)) : current.cooldownMinutes,
    triggers: nextTriggers,
    channels: nextChannels,
    history: current.history
  });

  return getPublicNotificationState();
}

function isValidHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function dispatchSingleChannel(name, fn) {
  try {
    await fn();
    return { channel: name, ok: true };
  } catch (err) {
    return { channel: name, ok: false, error: err.message || 'Fehler' };
  }
}

async function sendToEnabledChannels(config, { title, message, level = 'warn', source = 'system' }) {
  const tasks = [];
  const emoji = level === 'crit' ? '🚨' : level === 'ok' ? '✅' : '⚠️';

  if (config.channels.ntfy.enabled && isValidHttpUrl(config.channels.ntfy.url) && config.channels.ntfy.topic) {
    const endpoint = `${config.channels.ntfy.url.replace(/\/+$/, '')}/${encodeURIComponent(config.channels.ntfy.topic)}`;
    const headers = {
      Title: title,
      Priority: level === 'crit' ? 'urgent' : level === 'warn' ? 'high' : 'default',
      Tags: level === 'crit' ? 'rotating_light' : level === 'ok' ? 'white_check_mark' : 'warning'
    };
    if (config.channels.ntfy.token) {
      headers.Authorization = `Bearer ${config.channels.ntfy.token}`;
    }
    tasks.push(
      dispatchSingleChannel('ntfy', async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: String(message),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
    );
  }

  if (config.channels.discord.enabled && isValidHttpUrl(config.channels.discord.webhookUrl)) {
    const color = level === 'crit' ? 0xff453a : level === 'ok' ? 0x30d158 : 0xff9f0a;
    tasks.push(
      dispatchSingleChannel('discord', async () => {
        const res = await fetch(config.channels.discord.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Homeserver Dashboard',
            embeds: [
              {
                title: `${emoji} ${title}`,
                description: String(message),
                color,
                footer: { text: `Quelle: ${source}` },
                timestamp: new Date().toISOString()
              }
            ]
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
    );
  }

  if (config.channels.telegram.enabled && config.channels.telegram.botToken && config.channels.telegram.chatId) {
    const tgUrl = `https://api.telegram.org/bot${encodeURIComponent(config.channels.telegram.botToken)}/sendMessage`;
    tasks.push(
      dispatchSingleChannel('telegram', async () => {
        const res = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.channels.telegram.chatId,
            text: `${emoji} ${title}\n\n${message}`
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
    );
  }

  if (config.channels.webhook.enabled && isValidHttpUrl(config.channels.webhook.url)) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.channels.webhook.secret) {
      const secretVal = String(config.channels.webhook.secret).trim();
      headers['X-Webhook-Secret'] = secretVal;
      headers.Authorization = /^Bearer\s+/i.test(secretVal) ? secretVal : `Bearer ${secretVal}`;
    }
    tasks.push(
      dispatchSingleChannel('webhook', async () => {
        const res = await fetch(config.channels.webhook.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: 'homeserver_notification',
            source,
            level,
            title,
            message,
            timestamp: new Date().toISOString()
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
    );
  }

  if (tasks.length === 0) {
    return [];
  }

  const results = await Promise.all(tasks);
  config.history.unshift({
    ts: new Date().toISOString(),
    level,
    source,
    title,
    message: String(message).slice(0, 260),
    results
  });
  saveNotificationData(config);
  return results;
}

async function notifyWithCooldown(triggerType, key, title, message, level = 'warn', source = 'system') {
  const config = loadNotificationData();
  if (!config.enabled) return [];
  if (triggerType && config.triggers && config.triggers[triggerType] === false) return [];

  const cooldownMs = (config.cooldownMinutes || 30) * 60 * 1000;
  const now = Date.now();
  const prev = lastSentByKey.get(key) || 0;
  if (now - prev < cooldownMs) return [];

  lastSentByKey.set(key, now);
  return await sendToEnabledChannels(config, { title, message, level, source });
}

async function notifyWatchdogEvent(key, title, message, level = 'warn') {
  return await notifyWithCooldown('watchdog', `wd:${key}`, title, message, level, 'watchdog');
}

function evaluateSystemNotifications(snapshot) {
  const now = Date.now();
  if (now - lastEvaluateAt < 15_000) return;
  lastEvaluateAt = now;

  const config = loadNotificationData();
  if (!config.enabled) return;

  const cpuTemp = snapshot?.system?.cpu?.tempC;
  if (config.triggers.cpuTemp && Number.isFinite(cpuTemp) && cpuTemp >= 82) {
    notifyWithCooldown(
      'cpuTemp',
      'sys:cpu-temp',
      'Hohe CPU-Temperatur',
      `Prozessor-Temperatur liegt bei ${cpuTemp.toFixed(1)} °C (Schwellwert ≥ 82 °C).`,
      cpuTemp >= 90 ? 'crit' : 'warn',
      'telemetry'
    ).catch(() => {});
  }

  const disks = snapshot?.storage?.disks || [];
  for (const d of disks) {
    if (config.triggers.smart && d.smartHealthy === false) {
      notifyWithCooldown(
        'smart',
        `disk:smart:${d.device}`,
        `SMART-Warnung: ${d.label || d.device}`,
        `Laufwerk ${d.device} (${d.mountpoint}) meldet einen kritischen SMART-Status!`,
        'crit',
        'storage'
      ).catch(() => {});
    }
    if (config.triggers.diskTemp && Number.isFinite(d.tempC) && d.tempC >= 55) {
      notifyWithCooldown(
        'diskTemp',
        `disk:temp:${d.device}`,
        `Hohe Laufwerkstemperatur: ${d.label || d.device}`,
        `Temperatur von ${d.device} (${d.mountpoint}) beträgt ${d.tempC} °C (≥ 55 °C).`,
        d.tempC >= 62 ? 'crit' : 'warn',
        'storage'
      ).catch(() => {});
    }
    if (config.triggers.diskFull && Number.isFinite(d.usedPercent) && d.usedPercent >= 90) {
      notifyWithCooldown(
        'diskFull',
        `disk:full:${d.mountpoint}`,
        `Speicher fast voll: ${d.label || d.mountpoint}`,
        `Laufwerk ${d.mountpoint} ist zu ${d.usedPercent.toFixed(1)} % belegt.`,
        d.usedPercent >= 96 ? 'crit' : 'warn',
        'storage'
      ).catch(() => {});
    }
  }
}

async function sendTestNotification() {
  const config = loadNotificationData();
  const results = await sendToEnabledChannels(config, {
    title: 'Homeserver Dashboard Test',
    message: `Push-Benachrichtigungen sind korrekt eingerichtet (${new Date().toLocaleString('de-DE')}).`,
    level: 'ok',
    source: 'test'
  });
  if (results.length === 0) {
    const err = new Error('Kein Benachrichtigungskanal aktiviert oder unvollständig konfiguriert.');
    err.statusCode = 400;
    throw err;
  }
  return {
    ok: results.some((r) => r.ok),
    results,
    state: getPublicNotificationState()
  };
}

module.exports = {
  getPublicNotificationState,
  saveNotificationConfig,
  sendTestNotification,
  notifyWithCooldown,
  notifyWatchdogEvent,
  evaluateSystemNotifications
};
