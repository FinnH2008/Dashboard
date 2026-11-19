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

let lastNetResult = null;
let lastNetComputedAt = 0;

function resolveHostNetDevPath() {
  if (PROC_DIR === '/host/proc') {
    const pid1NetDev = '/host/proc/1/net/dev';
    if (fs.existsSync(pid1NetDev)) return pid1NetDev;
  }
  return path.join(PROC_DIR, 'net', 'dev');
}

function getNetworkThroughput() {
  const now = Date.now();
  if (lastNetResult && now - lastNetComputedAt < 350) {
    return lastNetResult;
  }

  const raw = readTextSafe(resolveHostNetDevPath());
  const interfaces = [];

  if (raw) {
    const lines = raw.split('\n').slice(2);
    for (const line of lines) {
      if (!line.includes(':')) continue;
      const [namePart, statsPart] = line.split(':');
      const name = namePart.trim();
      if (
        !name ||
        name === 'lo' ||
        name.startsWith('veth') ||
        name.startsWith('br-') ||
        name.startsWith('docker') ||
        name.startsWith('vnet') ||
        name.startsWith('virbr') ||
        name.startsWith('dummy') ||
        name.startsWith('ifb') ||
        name === 'sit0' ||
        name === 'tunl0' ||
        name === 'ip6tnl0'
      ) {
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
      if (prev && dtSec > 0.05) {
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

  perInterface.sort((a, b) => {
    const rateDiff = b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec);
    if (rateDiff !== 0) return rateDiff;
    return b.totalRxBytes + b.totalTxBytes - (a.totalRxBytes + a.totalTxBytes);
  });

  prevNetSnapshot = { timestamp: now, interfaces };
  lastNetComputedAt = now;
  lastNetResult = {
    rxBytesPerSec: Math.round(rxBytesPerSec),
    txBytesPerSec: Math.round(txBytesPerSec),
    interfaces: perInterface
  };

  return lastNetResult;
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

function isTailscaleIpv4(ip) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(ip || ''));
}

function isPrivateLanIpv4(ip) {
  const s = String(ip || '');
  return (
    s.startsWith('192.168.') ||
    s.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(s)
  );
}

function readHostFibTrieLocalIps() {
  const candidates = [];
  if (PROC_DIR === '/host/proc') {
    candidates.push('/host/proc/1/net/fib_trie');
  }
  candidates.push(path.join(PROC_DIR, 'net', 'fib_trie'));

  const ips = new Set();
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes('/32 host LOCAL')) continue;
        for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
          const m = lines[j].match(/(\d{1,3}(?:\.\d{1,3}){3})/);
          if (m && !m[1].startsWith('127.')) {
            ips.add(m[1]);
            break;
          }
        }
      }
      if (ips.size > 0) break;
    } catch {
      // ignore unreadable fib_trie
    }
  }
  return [...ips];
}

function getHostNetworkAddresses() {
  const all = new Set(readHostFibTrieLocalIps());
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs || name === 'lo') continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('127.')) {
        if (!name.startsWith('docker') && !name.startsWith('br-') && !name.startsWith('veth')) {
          all.add(addr.address);
        }
      }
    }
  }

  const list = [...all];
  const tailscaleIp = list.find((ip) => isTailscaleIpv4(ip)) || null;
  // Prefer typical home LAN ranges (192.168.x.x, 10.x.x.x) over Docker bridge 172.17.x.x
  const lanIp =
    list.find((ip) => ip.startsWith('192.168.')) ||
    list.find((ip) => ip.startsWith('10.')) ||
    list.find((ip) => isPrivateLanIpv4(ip) && !ip.startsWith('172.17.')) ||
    list.find((ip) => isPrivateLanIpv4(ip)) ||
    null;

  return {
    lanIp,
    tailscaleIp,
    allServerIps: list,
    primaryIp: lanIp || tailscaleIp || list[0] || '127.0.0.1'
  };
}

function getPrimaryIp() {
  return getHostNetworkAddresses().primaryIp;
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

let prevRapl = null; // { energyUj, ts }

function readRaplEnergyUj() {
  const candidates = [
    '/host/sys/class/powercap/intel-rapl:0/energy_uj',
    '/sys/class/powercap/intel-rapl:0/energy_uj'
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const val = Number(fs.readFileSync(file, 'utf8').trim());
        if (Number.isFinite(val) && val >= 0) return val;
      }
    } catch {
      // ignore permission or missing file
    }
  }
  return null;
}

function getPowerEstimate(cpuUsagePercent, powerConfig = null) {
  const idleWatts = Math.max(1, Number(powerConfig?.idleWatts) || 18);
  const maxWatts = Math.max(idleWatts, Number(powerConfig?.maxWatts) || 65);
  const kwhPriceEur = Math.max(0.01, Number(powerConfig?.kwhPriceEur) || 0.32);

  let watts = null;
  let source = 'estimated';

  const energyUj = readRaplEnergyUj();
  const now = Date.now();
  if (energyUj !== null) {
    if (prevRapl && now > prevRapl.ts && energyUj >= prevRapl.energyUj) {
      const dtSec = (now - prevRapl.ts) / 1000;
      const dJoules = (energyUj - prevRapl.energyUj) / 1_000_000;
      if (dtSec >= 0.4 && dJoules >= 0) {
        const pkgWatts = dJoules / dtSec;
        // Package power + base system overhead (fans, RAM, drives)
        watts = Math.round((pkgWatts + idleWatts * 0.45) * 10) / 10;
        source = 'rapl';
      }
    }
    prevRapl = { energyUj, ts: now };
  }

  if (watts === null) {
    const loadRatio = Math.max(0, Math.min(1, (Number(cpuUsagePercent) || 0) / 100));
    watts = Math.round((idleWatts + (maxWatts - idleWatts) * loadRatio) * 10) / 10;
  }

  const dailyKwh = Math.round(((watts * 24) / 1000) * 100) / 100;
  const monthlyKwh = Math.round(dailyKwh * 30 * 10) / 10;
  const monthlyCostEur = Math.round(monthlyKwh * kwhPriceEur * 100) / 100;

  return {
    watts,
    source,
    dailyKwh,
    monthlyKwh,
    monthlyCostEur,
    kwhPriceEur,
    idleWatts,
    maxWatts
  };
}

function collectSystemMetrics(customServerName, powerConfig = null) {
  const cpuInfo = os.cpus();
  const cpuModel = (cpuInfo[0] && cpuInfo[0].model ? cpuInfo[0].model : 'Linux CPU')
    .replace(/\s+/g, ' ')
    .trim();
  const cpuUsage = getCpuUsage();
  const memory = getMemoryInfo();
  const temperatures = getTemperatures();
  const network = getNetworkThroughput();
  const loadAvg = getLoadAvg();
  const power = getPowerEstimate(cpuUsage.totalPercent, powerConfig);

  const netAddrs = getHostNetworkAddresses();

  return {
    allowPower: ALLOW_HOST_POWER,
    hostname: customServerName || getHostHostname(),
    rawHostname: getHostHostname(),
    os: getOsRelease(),
    kernel: os.release(),
    arch: os.arch(),
    ipAddress: netAddrs.primaryIp,
    lanIp: netAddrs.lanIp,
    tailscaleIp: netAddrs.tailscaleIp,
    allServerIps: netAddrs.allServerIps,
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
    power,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  collectSystemMetrics,
  triggerHostPower,
  getHostNetworkAddresses
};
