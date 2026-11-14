const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROC_DIR = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';
const SYS_DIR = fs.existsSync('/host/sys') ? '/host/sys' : '/sys';

let prevCpuSnapshot = null;
let prevNetSnapshot = null;

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseProcStat() {
  const raw = readTextSafe(path.join(PROC_DIR, 'stat'));
  if (!raw) return null;

  const lines = raw.split('\n');
  const cpus = [];

  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    const nums = parts.slice(1).map((v) => Number(v) || 0);
    // user, nice, system, idle, iowait, irq, softirq, steal
    const idle = (nums[3] || 0) + (nums[4] || 0);
    const total = nums.slice(0, 8).reduce((acc, val) => acc + val, 0);
    cpus.push({ label, idle, total });
  }

  return cpus;
}

function getCpuUsage() {
  const current = parseProcStat();
  if (!current || current.length === 0) {
    const load = os.loadavg()[0] || 0;
    const count = os.cpus().length || 1;
    return {
      totalPercent: Math.min(100, Math.round((load / count) * 1000) / 10),
      cores: os.cpus().map((_, idx) => ({ core: idx, percent: 0 }))
    };
  }

  if (!prevCpuSnapshot) {
    prevCpuSnapshot = current;
    return {
      totalPercent: 0,
      cores: current.slice(1).map((_, idx) => ({ core: idx, percent: 0 }))
    };
  }

  const prevMap = new Map(prevCpuSnapshot.map((c) => [c.label, c]));
  let totalPercent = 0;
  const cores = [];

  for (const item of current) {
    const prev = prevMap.get(item.label);
    let pct = 0;
    if (prev) {
      const totalDelta = item.total - prev.total;
      const idleDelta = item.idle - prev.idle;
      if (totalDelta > 0) {
        pct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
      }
    }
    const rounded = Math.round(pct * 10) / 10;
    if (item.label === 'cpu') {
      totalPercent = rounded;
    } else {
      const coreNum = Number(item.label.replace('cpu', '')) || cores.length;
      cores.push({ core: coreNum, percent: rounded });
    }
  }

  prevCpuSnapshot = current;
  return { totalPercent, cores };
}

function getMemoryInfo() {
  const raw = readTextSafe(path.join(PROC_DIR, 'meminfo'));
  if (!raw) {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      totalBytes: total,
      usedBytes: used,
      availableBytes: free,
      cachedBytes: 0,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
    };
  }

  const map = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) {
      map[match[1]] = Number(match[2]) * 1024;
    }
  }

  const total = map.MemTotal || os.totalmem();
  const available = map.MemAvailable ?? (map.MemFree || os.freemem());
  const buffers = map.Buffers || 0;
  const cached = (map.Cached || 0) + (map.SReclaimable || 0);
  const used = Math.max(0, total - available);
  const swapTotal = map.SwapTotal || 0;
  const swapFree = map.SwapFree || 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    cachedBytes: buffers + cached,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
  };
}

function getTemperatures() {
  const temps = [];

  // Check thermal zones
  const thermalDir = path.join(SYS_DIR, 'class', 'thermal');
  try {
    if (fs.existsSync(thermalDir)) {
      const entries = fs.readdirSync(thermalDir).filter((e) => e.startsWith('thermal_zone'));
      for (const entry of entries) {
        const tempRaw = readTextSafe(path.join(thermalDir, entry, 'temp'));
        const typeRaw = readTextSafe(path.join(thermalDir, entry, 'type'));
        if (tempRaw !== null) {
          const val = Number(tempRaw.trim()) / 1000;
          if (Number.isFinite(val) && val > 0 && val < 130) {
            temps.push({
              label: (typeRaw || entry).trim(),
              celsius: Math.round(val * 10) / 10
            });
          }
        }
      }
    }
  } catch {
    // ignore permission or missing sysfs errors
  }

  // Check hwmon for coretemp / k10temp / nvme
  const hwmonDir = path.join(SYS_DIR, 'class', 'hwmon');
  try {
    if (fs.existsSync(hwmonDir)) {
      const entries = fs.readdirSync(hwmonDir);
      for (const hw of entries) {
        const hwPath = path.join(hwmonDir, hw);
        const name = (readTextSafe(path.join(hwPath, 'name')) || hw).trim();
        const files = fs.readdirSync(hwPath).filter((f) => /^temp\d+_input$/.test(f));
        for (const f of files) {
          const idx = f.match(/^temp(\d+)_input$/)[1];
          const rawVal = readTextSafe(path.join(hwPath, f));
          const labelVal = readTextSafe(path.join(hwPath, `temp${idx}_label`));
          if (rawVal !== null) {
            const val = Number(rawVal.trim()) / 1000;
            if (Number.isFinite(val) && val > 0 && val < 130) {
              temps.push({
                label: labelVal ? `${name} (${labelVal.trim()})` : name,
                celsius: Math.round(val * 10) / 10
              });
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Pick primary CPU temperature
  const cpuSensor = temps.find((t) =>
    /package|tctl|tdie|core|cpu|x86_pkg/i.test(t.label)
  ) || temps[0] || null;

  return {
    cpuCelsius: cpuSensor ? cpuSensor.celsius : null,
    sensors: temps.slice(0, 8)
  };
}

function getNetworkThroughput() {
  const raw = readTextSafe(path.join(PROC_DIR, 'net', 'dev'));
  const now = Date.now();
  const interfaces = [];

  if (raw) {
    const lines = raw.split('\n').slice(2);
    for (const line of lines) {
      if (!line.includes(':')) continue;
      const [namePart, statsPart] = line.split(':');
      const name = namePart.trim();
      if (!name || name === 'lo' || name.startsWith('veth') || name.startsWith('br-') || name.startsWith('docker')) {
        continue;
      }
      const cols = statsPart.trim().split(/\s+/).map((n) => Number(n) || 0);
      interfaces.push({
        name,
        rxBytes: cols[0] || 0,
        txBytes: cols[8] || 0
      });
    }
  }

  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  const perInterface = [];

  if (prevNetSnapshot && now > prevNetSnapshot.timestamp) {
    const dtSec = (now - prevNetSnapshot.timestamp) / 1000;
    const prevMap = new Map(prevNetSnapshot.interfaces.map((i) => [i.name, i]));
    for (const iface of interfaces) {
      const prev = prevMap.get(iface.name);
      let rxRate = 0;
      let txRate = 0;
      if (prev && dtSec > 0.1) {
        rxRate = Math.max(0, (iface.rxBytes - prev.rxBytes) / dtSec);
        txRate = Math.max(0, (iface.txBytes - prev.txBytes) / dtSec);
      }
      rxBytesPerSec += rxRate;
      txBytesPerSec += txRate;
      perInterface.push({
        name: iface.name,
        rxBytesPerSec: Math.round(rxRate),
        txBytesPerSec: Math.round(txRate),
        totalRxBytes: iface.rxBytes,
        totalTxBytes: iface.txBytes
      });
    }
  } else {
    for (const iface of interfaces) {
      perInterface.push({
        name: iface.name,
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
        totalRxBytes: iface.rxBytes,
        totalTxBytes: iface.txBytes
      });
    }
  }

  prevNetSnapshot = { timestamp: now, interfaces };

  return {
    rxBytesPerSec: Math.round(rxBytesPerSec),
    txBytesPerSec: Math.round(txBytesPerSec),
    interfaces: perInterface
  };
}

function getOsRelease() {
  const candidates = ['/host/etc/os-release', '/etc/os-release'];
  for (const file of candidates) {
    const raw = readTextSafe(file);
    if (raw) {
      const match = raw.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (match) return match[1];
    }
  }
  return `${os.type()} ${os.release()}`;
}

function getHostHostname() {
  if (process.env.SERVER_NAME) return process.env.SERVER_NAME;
  const hostHostname = readTextSafe('/host/etc/hostname');
  if (hostHostname && hostHostname.trim()) return hostHostname.trim();
  return os.hostname();
}

function getHostUptime() {
  const raw = readTextSafe(path.join(PROC_DIR, 'uptime'));
  if (raw) {
    const val = parseFloat(raw.trim().split(/\s+/)[0]);
    if (Number.isFinite(val)) return Math.floor(val);
  }
  return Math.floor(os.uptime());
}

function getLoadAvg() {
  const raw = readTextSafe(path.join(PROC_DIR, 'loadavg'));
  if (raw) {
    const parts = raw.trim().split(/\s+/);
    return [
      parseFloat(parts[0]) || 0,
      parseFloat(parts[1]) || 0,
      parseFloat(parts[2]) || 0
    ];
  }
  return os.loadavg().map((v) => Math.round(v * 100) / 100);
}

function getPrimaryIp() {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs || name === 'lo' || name.startsWith('docker') || name.startsWith('br-')) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

const ALLOW_HOST_POWER = String(process.env.ALLOW_HOST_POWER || 'false').toLowerCase() === 'true';

function triggerHostPower(action) {
  if (!ALLOW_HOST_POWER) {
    throw new Error('Host-Neustart/Herunterfahren ist deaktiviert (ALLOW_HOST_POWER=true setzen).');
  }
  if (!['reboot', 'shutdown'].includes(action)) {
    throw new Error('Ungültige Power-Aktion');
  }
  const { execFile } = require('node:child_process');
  const cmd = action === 'reboot' ? 'reboot' : 'poweroff';
  // Try nsenter into host PID 1 if running privileged with hostPID, else sysrq fallback
  execFile('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', cmd], (err) => {
    if (err) {
      try {
        const sysrq = path.join(PROC_DIR, 'sysrq-trigger');
        fs.writeFileSync(sysrq, action === 'reboot' ? 'b' : 'o');
      } catch {
        // handled asynchronously
      }
    }
  });
  return { ok: true, action };
}

function collectSystemMetrics(customServerName) {
  const cpuInfo = os.cpus();
  const cpuModel = (cpuInfo[0] && cpuInfo[0].model ? cpuInfo[0].model : 'Linux CPU')
    .replace(/\s+/g, ' ')
    .trim();
  const cpuUsage = getCpuUsage();
  const memory = getMemoryInfo();
  const temperatures = getTemperatures();
  const network = getNetworkThroughput();
  const loadAvg = getLoadAvg();

  return {
    allowPower: ALLOW_HOST_POWER,
    hostname: customServerName || getHostHostname(),
    rawHostname: getHostHostname(),
    os: getOsRelease(),
    kernel: os.release(),
    arch: os.arch(),
    ipAddress: getPrimaryIp(),
    uptimeSeconds: getHostUptime(),
    cpu: {
      model: cpuModel,
      coresCount: cpuInfo.length || 1,
      usagePercent: cpuUsage.totalPercent,
      perCore: cpuUsage.cores,
      loadAvg,
      temperatureCelsius: temperatures.cpuCelsius
    },
    memory,
    temperatures,
    network,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  collectSystemMetrics,
  triggerHostPower
};
