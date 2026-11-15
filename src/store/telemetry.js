const fs = require('node:fs');
const path = require('node:path');

const MAX_TELEMETRY_POINTS = 900; // 15 minutes at 1s resolution (or longer at idle sampling)
const MIN_SAMPLE_INTERVAL_MS = 900;
const DISK_FLUSH_INTERVAL_MS = 15_000;

let loaded = false;
let points = [];
let lastFlushTs = 0;
let dirty = false;

function getTelemetryFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'telemetry-history.json');
}

function loadTelemetryHistory() {
  if (loaded) return points;
  loaded = true;
  const file = getTelemetryFile();
  try {
    if (!fs.existsSync(file)) {
      points = [];
      return points;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.points) ? parsed.points : [];
    points = rawList
      .filter((p) => p && Number.isFinite(Number(p.ts)) && Number(p.ts) > 0)
      .slice(-MAX_TELEMETRY_POINTS)
      .map((p) => ({
        ts: Number(p.ts),
        cpu: Number(p.cpu) || 0,
        ram: Number(p.ram) || 0,
        netRxMB: Number(p.netRxMB) || 0,
        netTxMB: Number(p.netTxMB) || 0,
        diskReadMB: Number(p.diskReadMB) || 0,
        diskWriteMB: Number(p.diskWriteMB) || 0
      }));
  } catch {
    points = [];
  }
  return points;
}

function flushTelemetryHistorySync() {
  if (!dirty) return;
  const file = getTelemetryFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      points
    };
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    dirty = false;
    lastFlushTs = Date.now();
  } catch {
    // ignore read-only / transient fs errors
  }
}

function recordTelemetryPoint(snapshot, forceFlush = false) {
  if (!snapshot || !snapshot.system) return null;
  loadTelemetryHistory();

  const now = Date.now();
  const prev = points[points.length - 1];
  if (prev && now - prev.ts < MIN_SAMPLE_INTERVAL_MS) {
    return prev;
  }

  const point = {
    ts: now,
    cpu: Math.round((Number(snapshot.system?.cpu?.usagePercent) || 0) * 10) / 10,
    ram: Math.round((Number(snapshot.system?.memory?.usedPercent) || 0) * 10) / 10,
    netRxMB: Math.round(((Number(snapshot.system?.network?.rxBytesPerSec) || 0) / (1024 * 1024)) * 10000) / 10000,
    netTxMB: Math.round(((Number(snapshot.system?.network?.txBytesPerSec) || 0) / (1024 * 1024)) * 10000) / 10000,
    diskReadMB: Math.round(((Number(snapshot.storage?.totals?.readBytesPerSec) || 0) / (1024 * 1024)) * 10000) / 10000,
    diskWriteMB: Math.round(((Number(snapshot.storage?.totals?.writeBytesPerSec) || 0) / (1024 * 1024)) * 10000) / 10000
  };

  points.push(point);
  if (points.length > MAX_TELEMETRY_POINTS) {
    points.splice(0, points.length - MAX_TELEMETRY_POINTS);
  }
  dirty = true;

  if (forceFlush || now - lastFlushTs >= DISK_FLUSH_INTERVAL_MS) {
    flushTelemetryHistorySync();
  }

  return point;
}

function getTelemetryHistory(limit = 300, rangeSec = 0) {
  loadTelemetryHistory();
  const max = Math.max(1, Math.min(MAX_TELEMETRY_POINTS, Number(limit) || 300));
  let filtered = points;
  if (Number(rangeSec) > 0) {
    const cutoff = Date.now() - Number(rangeSec) * 1000;
    filtered = points.filter((p) => p.ts >= cutoff);
  }
  const sliced = filtered.slice(-max);
  const lastTs = sliced[sliced.length - 1]?.ts || points[points.length - 1]?.ts || null;
  return {
    lastSampleAt: lastTs ? new Date(lastTs).toISOString() : null,
    count: sliced.length,
    totalStored: points.length,
    points: sliced
  };
}

function getLastSampleAgeMs() {
  loadTelemetryHistory();
  const last = points[points.length - 1];
  return last ? Date.now() - last.ts : Infinity;
}

module.exports = {
  loadTelemetryHistory,
  recordTelemetryPoint,
  flushTelemetryHistorySync,
  getTelemetryHistory,
  getLastSampleAgeMs
};
