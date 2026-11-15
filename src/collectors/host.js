const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PING_FILE = path.join(DATA_DIR, 'ping-targets.json');
const PROC_DIR = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

const prevProcCpu = new Map(); // pid -> { procTime, ts }

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getClkTck() {
  return 100; // Standard Linux USER_HZ
}

function getTotalRamBytes() {
  try {
    const raw = fs.readFileSync(path.join(PROC_DIR, 'meminfo'), 'utf8');
    const match = raw.match(/^MemTotal:\s+(\d+)/m);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // fallback
  }
  return os.totalmem();
}

async function collectHostProcesses(limit = 15) {
  const now = Date.now();
  const totalRam = getTotalRamBytes();
  const pageSize = 4096;
  const clkTck = getClkTck();

  let entries = [];
  try {
    entries = await fsp.readdir(PROC_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const pids = entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name));

  const seenPids = new Set();
  const processes = [];

  for (const pid of pids) {
    seenPids.add(pid);
    try {
      const statRaw = await fsp.readFile(path.join(PROC_DIR, String(pid), 'stat'), 'utf8');
      const rparen = statRaw.lastIndexOf(')');
      if (rparen === -1) continue;
      const lparen = statRaw.indexOf('(');
      const comm = statRaw.slice(lparen + 1, rparen);
      const rest = statRaw.slice(rparen + 2).trim().split(/\s+/);
      // rest[0] = state (field 3), utime = field 14 (rest[11]), stime = field 15 (rest[12]), rss = field 24 (rest[21])
      const state = rest[0] || '?';
      const utime = Number(rest[11]) || 0;
      const stime = Number(rest[12]) || 0;
      const rssPages = Number(rest[21]) || 0;
      const rssBytes = Math.max(0, rssPages * pageSize);

      const procTime = utime + stime;
      let cpuPercent = 0;
      const prev = prevProcCpu.get(pid);
      if (prev && now > prev.ts && procTime >= prev.procTime) {
        const dtSec = (now - prev.ts) / 1000;
        const dProcSec = (procTime - prev.procTime) / clkTck;
        if (dtSec > 0.05) {
          cpuPercent = Math.min(100 * (os.cpus().length || 1), Math.round((dProcSec / dtSec) * 1000) / 10);
        }
      }
      prevProcCpu.set(pid, { procTime, ts: now });

      let cmdline = '';
      try {
        const cmdRaw = await fsp.readFile(path.join(PROC_DIR, String(pid), 'cmdline'), 'utf8');
        cmdline = cmdRaw.replace(/\0+/g, ' ').trim();
      } catch {
        // ignore
      }

      processes.push({
        pid,
        name: comm,
        command: (cmdline || comm).slice(0, 140),
        state,
        cpuPercent,
        rssBytes,
        memPercent: totalRam > 0 ? Math.round((rssBytes / totalRam) * 1000) / 10 : 0
      });
    } catch {
      // process exited or unreadable
    }
  }

  for (const oldPid of prevProcCpu.keys()) {
    if (!seenPids.has(oldPid)) prevProcCpu.delete(oldPid);
  }

  processes.sort((a, b) => {
    if (b.cpuPercent !== a.cpuPercent) return b.cpuPercent - a.cpuPercent;
    return b.rssBytes - a.rssBytes;
  });

  return processes.slice(0, limit);
}

function decodeHexIpv4(hex) {
  if (!hex || hex.length !== 8) return '0.0.0.0';
  const b = [
    parseInt(hex.slice(6, 8), 16),
    parseInt(hex.slice(4, 6), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(0, 2), 16)
  ];
  return b.join('.');
}

function decodeHexIpv6(hex) {
  if (!hex || hex.length !== 32) return '::';
  if (/^0+$/.test(hex)) return '::';
  if (hex === '00000000000000000000000001000000') return '::1';
  if (hex.startsWith('0000000000000000ffff0000')) {
    return decodeHexIpv4(hex.slice(24));
  }
  const groups = [];
  for (let i = 0; i < 32; i += 8) {
    const word = hex.slice(i, i + 8);
    // little-endian 32-bit words
    groups.push(word.slice(6, 8) + word.slice(4, 6));
    groups.push(word.slice(2, 4) + word.slice(0, 2));
  }
  return groups.join(':');
}

function parseProcNetTcp(filename, protoLabel, isV6) {
  const filePath = path.join(PROC_DIR, 'net', filename);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').slice(1);
    const out = [];
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const st = cols[3];
      if (st !== '0A') continue; // TCP_LISTEN
      const [ipHex, portHex] = cols[1].split(':');
      const port = parseInt(portHex, 16);
      if (!Number.isFinite(port) || port <= 0) continue;
      const address = isV6 ? decodeHexIpv6(ipHex) : decodeHexIpv4(ipHex);
      const inode = cols[9] || '';
      out.push({ proto: protoLabel, address, port, inode });
    }
    return out;
  } catch {
    return [];
  }
}

function collectListeningPorts(dockerContainers = []) {
  const portToContainers = new Map();
  for (const c of dockerContainers) {
    if (c.state !== 'running') continue;
    for (const p of c.ports || []) {
      const existing = portToContainers.get(p.publicPort) || [];
      if (!existing.includes(c.name)) existing.push(c.name);
      portToContainers.set(p.publicPort, existing);
    }
  }

  const raw = [
    ...parseProcNetTcp('tcp', 'TCP4', false),
    ...parseProcNetTcp('tcp6', 'TCP6', true)
  ];

  const merged = new Map();
  for (const entry of raw) {
    const key = `${entry.proto}:${entry.port}:${entry.address}`;
    if (!merged.has(key)) {
      const containers = portToContainers.get(entry.port) || [];
      const scope = entry.address === '127.0.0.1' || entry.address === '::1' ? 'localhost' : 'LAN / Alle';
      merged.set(key, {
        proto: entry.proto,
        address: entry.address,
        port: entry.port,
        scope,
        service: containers.length > 0 ? `Docker: ${containers.join(', ')}` : guessWellKnownPort(entry.port)
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.port - b.port);
}

function guessWellKnownPort(port) {
  const map = {
    22: 'SSH',
    53: 'DNS',
    80: 'HTTP',
    139: 'Samba NetBIOS',
    443: 'HTTPS',
    445: 'Samba (SMB)',
    2283: 'Immich',
    3080: 'Homeserver Dashboard',
    5000: 'Registry / Dienst',
    8080: 'HTTP Alt',
    8096: 'Jellyfin',
    9000: 'Portainer',
    9443: 'Portainer HTTPS',
    32400: 'Plex',
    41641: 'Tailscale',
    51820: 'WireGuard'
  };
  return map[port] || 'Host-Dienst';
}

function collectVpnStatus(dockerContainers = []) {
  const netDevPath = path.join(PROC_DIR, 'net', 'dev');
  const devStats = new Map();
  if (fs.existsSync(netDevPath)) {
    try {
      const raw = fs.readFileSync(netDevPath, 'utf8');
      for (const line of raw.split('\n').slice(2)) {
        if (!line.includes(':')) continue;
        const [ifaceRaw, valsRaw] = line.split(':');
        const iface = ifaceRaw.trim();
        const vals = valsRaw.trim().split(/\s+/).map((v) => Number(v) || 0);
        devStats.set(iface, { rxBytes: vals[0] || 0, txBytes: vals[8] || 0 });
      }
    } catch {
      // ignore
    }
  }

  const osIfaces = os.networkInterfaces();
  const vpnInterfaces = [];
  const candidateNames = new Set([...devStats.keys(), ...Object.keys(osIfaces)]);

  for (const name of candidateNames) {
    const lower = name.toLowerCase();
    let provider = null;
    if (lower.startsWith('tailscale')) provider = 'Tailscale';
    else if (lower.startsWith('wg')) provider = 'WireGuard';
    else if (lower.startsWith('tun') || lower.startsWith('tap')) provider = 'VPN Tunnel';
    else if (lower.startsWith('zt')) provider = 'ZeroTier';
    if (!provider) continue;

    const addrs = (osIfaces[name] || []).map((a) => `${a.address}`).filter(Boolean);
    const stats = devStats.get(name) || { rxBytes: 0, txBytes: 0 };
    vpnInterfaces.push({
      interface: name,
      provider,
      active: true,
      addresses: addrs,
      rxBytes: stats.rxBytes,
      txBytes: stats.txBytes
    });
  }

  // Also check if tailscale/wireguard runs inside Docker
  const vpnContainers = dockerContainers
    .filter((c) => c.state === 'running' && /(tailscale|wireguard|wg-easy|headscale|zerotier)/i.test(`${c.name} ${c.image}`))
    .map((c) => ({
      name: c.name,
      image: c.image,
      statusText: c.statusText
    }));

  return {
    interfaces: vpnInterfaces,
    containers: vpnContainers
  };
}

function loadPingTargets() {
  ensureDataDir();
  if (!fs.existsSync(PING_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PING_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePingTargets(list = []) {
  ensureDataDir();
  const clean = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 60);
    const host = String(item.host || '').trim().slice(0, 120);
    const portNum = Number(item.port);
    const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : null;
    if (!host || !/^[a-zA-Z0-9._:-]+$/.test(host)) continue;
    clean.push({
      id: String(item.id || `ping-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      name: name || host,
      host,
      port
    });
  }
  fs.writeFileSync(PING_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (online, err = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({
        online,
        latencyMs: online ? Math.max(0.1, Math.round((performance.now() - start) * 10) / 10) : null,
        method: `TCP:${port}`,
        error: err
      });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'Zeitüberschreitung'));
    socket.on('error', (err) => finish(false, err.code || err.message));
  });
}

async function icmpPing(host) {
  const start = performance.now();
  try {
    const { stdout } = await execFileAsync('ping', ['-c', '1', '-W', '1', host], { timeout: 2000 });
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
    const latencyMs = match ? Number(match[1]) : Math.round((performance.now() - start) * 10) / 10;
    return { online: true, latencyMs, method: 'ICMP', error: null };
  } catch (err) {
    return { online: false, latencyMs: null, method: 'ICMP', error: err.code === 'ENOENT' ? 'ping fehlt' : 'Nicht erreichbar' };
  }
}

async function checkSinglePingTarget(target) {
  if (target.port) {
    const res = await tcpProbe(target.host, target.port);
    return { ...target, ...res, checkedAt: new Date().toISOString() };
  }
  const icmp = await icmpPing(target.host);
  if (icmp.error === 'ping fehlt') {
    const fallback = await tcpProbe(target.host, 80, 1200);
    return { ...target, ...fallback, checkedAt: new Date().toISOString() };
  }
  return { ...target, ...icmp, checkedAt: new Date().toISOString() };
}

async function checkAllPingTargets() {
  const targets = loadPingTargets();
  if (targets.length === 0) return [];
  return await Promise.all(targets.map((t) => checkSinglePingTarget(t)));
}

async function collectHostAndNetworkStatus(dockerContainers = []) {
  const [processes, pingTargets] = await Promise.all([
    collectHostProcesses(15),
    checkAllPingTargets()
  ]);
  const ports = collectListeningPorts(dockerContainers);
  const vpn = collectVpnStatus(dockerContainers);

  return {
    procSource: PROC_DIR,
    processes,
    ports,
    vpn,
    pingTargets
  };
}

module.exports = {
  collectHostAndNetworkStatus,
  loadPingTargets,
  savePingTargets
};
