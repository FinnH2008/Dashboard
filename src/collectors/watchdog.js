const fs = require('node:fs');
const path = require('node:path');
const { collectDockerContainers, controlContainer } = require('./docker');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const AUTOMATION_FILE = path.join(DATA_DIR, 'automation.json');

const DEFAULT_AUTOMATION = {
  watchdog: {
    enabled: false,
    mode: 'all', // 'all' | 'selected' | 'label'
    containerNames: [],
    cooldownSeconds: 180,
    restartUnhealthy: true,
    restartExitedError: false
  },
  schedules: [],
  events: []
};

const lastRestartAt = new Map();
let schedulerTimer = null;
let checkInFlight = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadAutomationData() {
  ensureDataDir();
  if (!fs.existsSync(AUTOMATION_FILE)) {
    return JSON.parse(JSON.stringify(DEFAULT_AUTOMATION));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTOMATION_FILE, 'utf8'));
    return {
      watchdog: {
        ...DEFAULT_AUTOMATION.watchdog,
        ...(parsed.watchdog && typeof parsed.watchdog === 'object' ? parsed.watchdog : {})
      },
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
      events: Array.isArray(parsed.events) ? parsed.events.slice(0, 100) : []
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_AUTOMATION));
  }
}

function saveAutomationData(data) {
  ensureDataDir();
  const payload = {
    watchdog: data.watchdog,
    schedules: data.schedules,
    events: (data.events || []).slice(0, 100)
  };
  fs.writeFileSync(AUTOMATION_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function recordAutomationEvent(source, level, message) {
  const data = loadAutomationData();
  data.events.unshift({
    ts: new Date().toISOString(),
    source: source || 'system',
    level: level || 'ok',
    message: String(message || '')
  });
  if (data.events.length > 100) data.events.length = 100;
  saveAutomationData(data);
}

function saveWatchdogConfig(patch = {}) {
  const data = loadAutomationData();
  const mode = ['all', 'selected', 'label'].includes(patch.mode) ? patch.mode : data.watchdog.mode;
  const cooldownSeconds = Math.max(30, Math.min(3600, Number(patch.cooldownSeconds) || data.watchdog.cooldownSeconds || 180));
  const containerNames = Array.isArray(patch.containerNames)
    ? patch.containerNames.map((n) => String(n).trim()).filter(Boolean)
    : data.watchdog.containerNames;

  data.watchdog = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : data.watchdog.enabled,
    mode,
    containerNames,
    cooldownSeconds,
    restartUnhealthy: patch.restartUnhealthy !== undefined ? Boolean(patch.restartUnhealthy) : data.watchdog.restartUnhealthy,
    restartExitedError: patch.restartExitedError !== undefined ? Boolean(patch.restartExitedError) : data.watchdog.restartExitedError
  };
  saveAutomationData(data);
  recordAutomationEvent(
    'watchdog',
    'ok',
    `Watchdog ${data.watchdog.enabled ? 'aktiviert' : 'deaktiviert'} (Modus: ${data.watchdog.mode}, Cooldown: ${data.watchdog.cooldownSeconds}s).`
  );
  return getAutomationState();
}

function saveSchedules(list = []) {
  const data = loadAutomationData();
  const allowedTypes = new Set(['container-restart', 'media-scan', 'storage-analysis']);
  const cleaned = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const type = allowedTypes.has(item.type) ? item.type : 'media-scan';
    const timeHHMM = /^\d{2}:\d{2}$/.test(String(item.timeHHMM || '')) ? String(item.timeHHMM) : '03:00';
    cleaned.push({
      id: String(item.id || `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      name: String(item.name || 'Geplante Aufgabe').trim().slice(0, 80),
      enabled: item.enabled !== false,
      type,
      target: String(item.target || '').trim().slice(0, 120),
      timeHHMM,
      lastRunDate: item.lastRunDate ? String(item.lastRunDate) : null
    });
  }
  data.schedules = cleaned;
  saveAutomationData(data);
  return getAutomationState();
}

function getAutomationState() {
  return loadAutomationData();
}

async function executeScheduleTask(sched, callbacks = {}) {
  if (sched.type === 'container-restart') {
    if (!sched.target) throw new Error('Kein Container-Name für Neustart angegeben.');
    await controlContainer(sched.target, 'restart');
    recordAutomationEvent('schedule', 'ok', `Zeitplan "${sched.name}": Container "${sched.target}" neu gestartet.`);
    return;
  }
  if (sched.type === 'media-scan' && typeof callbacks.onMediaScan === 'function') {
    await callbacks.onMediaScan();
    recordAutomationEvent('schedule', 'ok', `Zeitplan "${sched.name}": Mediathek-Scan gestartet.`);
    return;
  }
  if (sched.type === 'storage-analysis' && typeof callbacks.onStorageAnalysis === 'function') {
    await callbacks.onStorageAnalysis();
    recordAutomationEvent('schedule', 'ok', `Zeitplan "${sched.name}": Speicher- & Duplikate-Analyse gestartet.`);
    return;
  }
  throw new Error('Aufgabentyp wird aktuell nicht unterstützt.');
}

async function runScheduleNow(scheduleId, callbacks = {}) {
  const data = loadAutomationData();
  const idx = data.schedules.findIndex((s) => s.id === scheduleId);
  if (idx === -1) {
    const err = new Error('Zeitplan nicht gefunden.');
    err.statusCode = 404;
    throw err;
  }
  await executeScheduleTask(data.schedules[idx], callbacks);
  const now = new Date();
  data.schedules[idx].lastRunDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  saveAutomationData(data);
  return getAutomationState();
}

async function runTick(callbacks = {}) {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    const data = loadAutomationData();

    // 1. Watchdog Auto-Heal
    if (data.watchdog.enabled) {
      const docker = await collectDockerContainers();
      if (docker.available && docker.allowControl) {
        const cooldownMs = (data.watchdog.cooldownSeconds || 180) * 1000;
        const nowTs = Date.now();

        for (const c of docker.containers || []) {
          if (c.name === 'homeserver-dashboard') continue;

          let watched = false;
          if (data.watchdog.mode === 'all') watched = true;
          else if (data.watchdog.mode === 'selected') {
            watched = (data.watchdog.containerNames || []).includes(c.name);
          } else if (data.watchdog.mode === 'label') {
            watched = Boolean(c.autohealLabel);
          }
          if (!watched) continue;

          const isUnhealthy = data.watchdog.restartUnhealthy && c.state === 'running' && c.health === 'unhealthy';
          const isExitedError = data.watchdog.restartExitedError && c.state === 'exited' && /Exited \([1-9]/i.test(c.statusText || '');

          if (!isUnhealthy && !isExitedError) continue;

          const lastTs = lastRestartAt.get(c.name) || 0;
          if (nowTs - lastTs < cooldownMs) continue;

          lastRestartAt.set(c.name, nowTs);
          try {
            await controlContainer(c.id, 'restart');
            recordAutomationEvent(
              'watchdog',
              'warn',
              `Auto-Heal: Container "${c.name}" (${isUnhealthy ? 'Unhealthy' : c.statusText}) wurde automatisch neu gestartet.`
            );
          } catch (err) {
            recordAutomationEvent(
              'watchdog',
              'error',
              `Auto-Heal fehlgeschlagen für "${c.name}": ${err.message}`
            );
          }
        }
      }
    }

    // 2. Daily Schedules
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const curHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    let schedulesChanged = false;
    for (const sched of data.schedules) {
      if (!sched.enabled) continue;
      if (sched.timeHHMM !== curHHMM) continue;
      if (sched.lastRunDate === todayStr) continue;

      sched.lastRunDate = todayStr;
      schedulesChanged = true;
      try {
        await executeScheduleTask(sched, callbacks);
      } catch (err) {
        recordAutomationEvent('schedule', 'error', `Zeitplan "${sched.name}" fehlgeschlagen: ${err.message}`);
      }
    }
    if (schedulesChanged) {
      const fresh = loadAutomationData();
      fresh.schedules = data.schedules;
      saveAutomationData(fresh);
    }
  } finally {
    checkInFlight = false;
  }
}

function startWatchdogScheduler(callbacks = {}) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    runTick(callbacks).catch(() => {});
  }, 30_000);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
}

function stopWatchdogScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  getAutomationState,
  saveWatchdogConfig,
  saveSchedules,
  runScheduleNow,
  recordAutomationEvent,
  startWatchdogScheduler,
  stopWatchdogScheduler
};
