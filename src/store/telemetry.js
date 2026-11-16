const fs = require('node:fs');
const path = require('node:path');

const MAX_TELEMETRY_POINTS = 900; // 15 minutes at 1s resolution
const MAX_1M_POINTS = 1440; // 24 hours at 1m resolution
const MAX_5M_POINTS = 2016; // 7 days at 5m resolution
const MIN_SAMPLE_INTERVAL_MS = 900;
const DISK_FLUSH_INTERVAL_MS = 15_000;
const LONG_FLUSH_INTERVAL_MS = 60_000;

let loaded = false;
let points = [];
let points1m = [];
let points5m = [];
let lastFlushTs = 0;
let lastLongFlushTs = 0;
let dirty = false;
let longDirty = false;

let bucket1m = null;
let bucket5m = null;

function getTelemetryFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'telemetry-history.json');
}

function getLongTelemetryFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'telemetry-long.json');
}

function normalizePoint(p) {
  return {
    ts: Number(p.ts),
    cpu: Number(p.cpu) || 0,
    ram: Number(p.ram) || 0,
    cpuTemp: p.cpuTemp !== null && p.cpuTemp !== undefined ? Number(p.cpuTemp) : null,
    netRxMB: Number(p.netRxMB) || 0,
    netTxMB: Number(p.netTxMB) || 0,
    diskReadMB: Number(p.diskReadMB) || 0,
    diskWriteMB: Number(p.diskWriteMB) || 0
  };
}

function loadTelemetryHistory() {
  if (loaded) return points;
  loaded = true;
  const file = getTelemetryFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.points) ? parsed.points : [];
      points = rawList
        .filter((p) => p && Number.isFinite(Number(p.ts)) && Number(p.ts) > 0)
        .slice(-MAX_TELEMETRY_POINTS)
        .map(normalizePoint);
    }
  } catch {
    points = [];
  }

  const longFile = getLongTelemetryFile();
  try {
    if (fs.existsSync(longFile)) {
      const parsed = JSON.parse(fs.readFileSync(longFile, 'utf8'));
      if (Array.isArray(parsed?.points1m)) {
        points1m = parsed.points1m
          .filter((p) => p && Number.isFinite(Number(p.ts)) && Number(p.ts) > 0)
          .slice(-MAX_1M_POINTS)
          .map(normalizePoint);
      }
      if (Array.isArray(parsed?.points5m)) {
        points5m = parsed.points5m
          .filter((p) => p && Number.isFinite(Number(p.ts)) && Number(p.ts) > 0)
          .slice(-MAX_5M_POINTS)
          .map(normalizePoint);
      }
    }
  } catch {
    points1m = [];
    points5m = [];
  }
  return points;
}

function flushTelemetryHistorySync() {
  if (dirty) {
    const file = getTelemetryFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ updatedAt: new Date().toISOString(), points }),
        'utf8'
      );
      dirty = false;
      lastFlushTs = Date.now();
    } catch {
      // ignore fs errors
    }
  }
  if (longDirty) {
    const longFile = getLongTelemetryFile();
    try {
      fs.mkdirSync(path.dirname(longFile), { recursive: true });
      fs.writeFileSync(
        longFile,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          points1m,
          points5m
        }),
        'utf8'
      );
      longDirty = false;
      lastLongFlushTs = Date.now();
    } catch {
      // ignore fs errors
    }
  }
}

function finalizeBucket(bucket, targetArr, maxLen) {
  if (!bucket || bucket.count === 0) return;
  const n = bucket.count;
  targetArr.push({
    ts: bucket.bucketTs + bucket.windowMs,
    cpu: Math.round((bucket.cpu / n) * 10) / 10,
    ram: Math.round((bucket.ram / n) * 10) / 10,
    cpuTemp: bucket.tempCount > 0 ? Math.round((bucket.cpuTemp / bucket.tempCount) * 10) / 10 : null,
    netRxMB: Math.round((bucket.netRxMB / n) * 10000) / 10000,
    netTxMB: Math.round((bucket.netTxMB / n) * 10000) / 10000,
    diskReadMB: Math.round((bucket.diskReadMB / n) * 10000) / 10000,
    diskWriteMB: Math.round((bucket.diskWriteMB / n) * 10000) / 10000
  });
  if (targetArr.length > maxLen) {
    targetArr.splice(0, targetArr.length - maxLen);
  }
  longDirty = true;
}

function accumulateBucket(currentBucket, windowMs, point, targetArr, maxLen) {
  const bTs = Math.floor(point.ts / windowMs) * windowMs;
  if (currentBucket && currentBucket.bucketTs !== bTs) {
    finalizeBucket(currentBucket, targetArr, maxLen);
    currentBucket = null;
  }
  if (!currentBucket) {
    currentBucket = {
      bucketTs: bTs,
      windowMs,
      count: 0,
      tempCount: 0,
      cpu: 0,
      ram: 0,
      cpuTemp: 0,
      netRxMB: 0,
      netTxMB: 0,
      diskReadMB: 0,
      diskWriteMB: 0
    };
  }
  currentBucket.count += 1;
  currentBucket.cpu += point.cpu;
  currentBucket.ram += point.ram;
  if (point.cpuTemp !== null) {
    currentBucket.cpuTemp += point.cpuTemp;
    currentBucket.tempCount += 1;
  }
  currentBucket.netRxMB += point.netRxMB;
  currentBucket.netTxMB += point.netTxMB;
  currentBucket.diskReadMB += point.diskReadMB;
  currentBucket.diskWriteMB += point.diskWriteMB;
  return currentBucket;
}

function recordTelemetryPoint(snapshot, forceFlush = false) {
  if (!snapshot || !snapshot.system) return null;
  loadTelemetryHistory();

  const now = Date.now();
  const prev = points[points.length - 1];
  if (prev && now - prev.ts < MIN_SAMPLE_INTERVAL_MS) {
    return prev;
  }

  const rawTemp = snapshot.system?.cpu?.temperatureCelsius;
  const point = {
    ts: now,
    cpu: Math.round((Number(snapshot.system?.cpu?.usagePercent) || 0) * 10) / 10,
    ram: Math.round((Number(snapshot.system?.memory?.usedPercent) || 0) * 10) / 10,
    cpuTemp: rawTemp !== null && rawTemp !== undefined ? Math.round(Number(rawTemp) * 10) / 10 : null,
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

  bucket1m = accumulateBucket(bucket1m, 60_000, point, points1m, MAX_1M_POINTS);
  bucket5m = accumulateBucket(bucket5m, 300_000, point, points5m, MAX_5M_POINTS);

  if (forceFlush || now - lastFlushTs >= DISK_FLUSH_INTERVAL_MS || (longDirty && now - lastLongFlushTs >= LONG_FLUSH_INTERVAL_MS)) {
    flushTelemetryHistorySync();
  }

  return point;
}

function getTelemetryHistory(limit = 900, rangeSec = 0) {
  loadTelemetryHistory();
  const r = Number(rangeSec) || 0;
  let source = points;
  let resolution = '1s';

  if (r > 86400) {
    source = points5m.length > 0 ? points5m : points1m.length > 0 ? points1m : points;
    resolution = points5m.length > 0 ? '5m' : points1m.length > 0 ? '1m' : '1s';
  } else if (r > 900) {
    source = points1m.length > 0 ? points1m : points;
    resolution = points1m.length > 0 ? '1m' : '1s';
  }

  const max = Math.max(1, Math.min(2500, Number(limit) || 900));
  let filtered = source;
  if (r > 0) {
    const cutoff = Date.now() - r * 1000;
    filtered = source.filter((p) => p.ts >= cutoff);
  }
  const sliced = filtered.slice(-max);
  const lastTs = sliced[sliced.length - 1]?.ts || source[source.length - 1]?.ts || points[points.length - 1]?.ts || null;
  return {
    resolution,
    lastSampleAt: lastTs ? new Date(lastTs).toISOString() : null,
    count: sliced.length,
    totalStored: points.length,
    total1m: points1m.length,
    total5m: points5m.length,
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
