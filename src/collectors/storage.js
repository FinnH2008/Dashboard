const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const PROC_DIR = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

let prevDiskStats = null;
let smartCache = { timestamp: 0, byDevice: {} };
const SMART_CACHE_TTL_MS = 120_000; // 2 minutes to avoid spinning up idle HDDs

const IGNORED_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'sysfs',
  'proc',
  'devpts',
  'cgroup',
  'cgroup2',
  'pstore',
  'securityfs',
  'debugfs',
  'tracefs',
  'fusectl',
  'configfs',
  'squashfs',
  'overlay',
  'efivarfs',
  'hugetlbfs',
  'mqueue',
  'autofs',
  'rpc_pipefs',
  'nsfs',
  'ramfs'
]);

const IGNORED_MOUNT_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/etc/',
  '/usr/',
  '/var/lib/docker/',
  '/var/lib/apt',
  '/var/lib/dpkg',
  '/snap/'
];

function getConfiguredMountAllowlist() {
  const raw = process.env.DISK_MOUNTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runDf() {
  // -P ensures POSIX single-line output, -k uses 1K blocks (works in Alpine & Debian), -T prints fs type
  const attempts = [
    ['-P', '-k', '-T'],
    ['-P', '-k']
  ];

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync('df', args, { timeout: 3000 });
      const lines = stdout.trim().split('\n').slice(1);
      const hasType = args.includes('-T');
      const entries = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        // Handle edge case where filesystem name might be missing/blank in container df
        if (hasType && parts.length >= 7) {
          const filesystem = parts[0];
          const fsType = parts[1];
          const totalBytes = (Number(parts[2]) || 0) * 1024;
          const usedBytes = (Number(parts[3]) || 0) * 1024;
          const availBytes = (Number(parts[4]) || 0) * 1024;
          const mountpoint = parts.slice(6).join(' ');
          entries.push({ filesystem, fsType, totalBytes, usedBytes, availBytes, mountpoint });
        } else if (!hasType && parts.length >= 6) {
          const filesystem = parts[0];
          const totalBytes = (Number(parts[1]) || 0) * 1024;
          const usedBytes = (Number(parts[2]) || 0) * 1024;
          const availBytes = (Number(parts[3]) || 0) * 1024;
          const mountpoint = parts.slice(5).join(' ');
          entries.push({ filesystem, fsType: 'unknown', totalBytes, usedBytes, availBytes, mountpoint });
        }
      }
      return entries;
    } catch {
      // try next flag set
    }
  }
  return [];
}

let lsblkCache = { timestamp: 0, data: null };
const LSBLK_CACHE_TTL_MS = 30_000;
let smartRefreshInFlight = false;

async function runLsblk() {
  if (lsblkCache.data && Date.now() - lsblkCache.timestamp < LSBLK_CACHE_TTL_MS) {
    return lsblkCache.data;
  }
  try {
    const { stdout } = await execFileAsync(
      'lsblk',
      ['-J', '-b', '-o', 'NAME,KNAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL,SERIAL,TRAN,ROTA'],
      { timeout: 2500 }
    );
    const parsed = JSON.parse(stdout);
    const flat = [];

    function walk(nodes, parentInfo = null) {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        const info = {
          name: node.name,
          kname: node.kname || node.name,
          devPath: `/dev/${node.kname || node.name}`,
          sizeBytes: Number(node.size) || 0,
          type: node.type || 'disk',
          mountpoint: node.mountpoint || null,
          fstype: node.fstype || null,
          model: (node.model || parentInfo?.model || '').trim() || null,
          serial: (node.serial || parentInfo?.serial || '').trim() || null,
          tran: node.tran || parentInfo?.tran || null,
          rota: node.rota !== undefined && node.rota !== null ? Boolean(node.rota) : parentInfo?.rota ?? null,
          parentName: parentInfo ? parentInfo.name : node.name
        };
        flat.push(info);
        if (Array.isArray(node.children)) {
          walk(node.children, info);
        }
      }
    }

    walk(parsed.blockdevices || []);
    lsblkCache = { timestamp: Date.now(), data: flat };
    return flat;
  } catch {
    return lsblkCache.data || [];
  }
}

function getDiskIoRates() {
  const now = Date.now();
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(PROC_DIR, 'diskstats'), 'utf8');
  } catch {
    return {};
  }

  const current = {};
  for (const line of raw.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 14) continue;
    const devName = cols[2];
    if (!devName || devName.startsWith('loop') || devName.startsWith('ram')) continue;
    const sectorsRead = Number(cols[5]) || 0;
    const sectorsWritten = Number(cols[9]) || 0;
    current[devName] = { sectorsRead, sectorsWritten };
  }

  const rates = {};
  if (prevDiskStats && now > prevDiskStats.timestamp) {
    const dtSec = (now - prevDiskStats.timestamp) / 1000;
    if (dtSec > 0.1) {
      for (const [devName, stats] of Object.entries(current)) {
        const prev = prevDiskStats.devices[devName];
        if (prev) {
          // Standard Linux sector size is 512 bytes
          const readBytesPerSec = Math.max(0, ((stats.sectorsRead - prev.sectorsRead) * 512) / dtSec);
          const writeBytesPerSec = Math.max(0, ((stats.sectorsWritten - prev.sectorsWritten) * 512) / dtSec);
          rates[devName] = {
            readBytesPerSec: Math.round(readBytesPerSec),
            writeBytesPerSec: Math.round(writeBytesPerSec)
          };
        }
      }
    }
  }

  prevDiskStats = { timestamp: now, devices: current };
  return rates;
}

function querySmartInfo(blockDevices) {
  const now = Date.now();
  if (now - smartCache.timestamp < SMART_CACHE_TTL_MS || smartRefreshInFlight) {
    return smartCache.byDevice;
  }

  const physicalDisks = blockDevices.filter(
    (d) => d.type === 'disk' && !d.name.startsWith('loop') && !d.name.startsWith('ram') && !d.name.startsWith('zram')
  );

  if (physicalDisks.length === 0) {
    smartCache = { timestamp: now, byDevice: {} };
    return smartCache.byDevice;
  }

  smartRefreshInFlight = true;
  (async () => {
    const results = {};
    try {
      await Promise.all(
        physicalDisks.slice(0, 12).map(async (disk) => {
          try {
            const { stdout } = await execFileAsync('smartctl', ['-H', '-A', '-j', disk.devPath], { timeout: 2500 });
            const data = JSON.parse(stdout);
            const passed = data.smart_status?.passed;
            const temp = data.temperature?.current ?? null;
            const powerOnHours = data.power_on_time?.hours ?? null;
            results[disk.name] = {
              status: passed === true ? 'Gesund' : passed === false ? 'Warnung' : 'Unbekannt',
              healthy: passed !== false,
              temperatureCelsius: Number.isFinite(temp) ? temp : null,
              powerOnHours: Number.isFinite(powerOnHours) ? powerOnHours : null
            };
          } catch {
            // smartctl missing or needs CAP_SYS_RAWIO / privileged device access
          }
        })
      );
      smartCache = { timestamp: Date.now(), byDevice: results };
    } finally {
      smartRefreshInFlight = false;
    }
  })();

  return smartCache.byDevice;
}

function classifyDiskType(lsblkMatch, fsType, mountpoint) {
  if (fsType === 'fuse.mergerfs' || fsType === 'mergerfs' || fsType === 'fuse.unionfs') return 'MergerFS Pool';
  if (fsType === 'zfs' || fsType === 'btrfs') return fsType.toUpperCase();
  if (fsType === 'nfs' || fsType === 'nfs4' || fsType === 'cifs' || fsType === 'smb3') return 'Netzwerk-Share';
  if (lsblkMatch) {
    if (lsblkMatch.tran === 'nvme' || lsblkMatch.name.startsWith('nvme')) return 'NVMe SSD';
    if (lsblkMatch.tran === 'usb') return 'USB-Laufwerk';
    if (lsblkMatch.rota === false) return 'SATA SSD';
    if (lsblkMatch.rota === true) return 'SATA HDD';
  }
  if (/nvme/i.test(mountpoint)) return 'NVMe SSD';
  return 'Datenträger';
}

const ALLOW_STORAGE_ADMIN = String(process.env.ALLOW_STORAGE_ADMIN || 'false').toLowerCase() === 'true';

async function mountHostDevice(devPath, mountPoint, persistFstab = true) {
  if (!ALLOW_STORAGE_ADMIN) {
    throw new Error('Festplatten-Verwaltung erfordert ALLOW_STORAGE_ADMIN=true und privileged: true in docker-compose.yml.');
  }
  if (!/^\/dev\/[a-zA-Z0-9_-]+$/.test(devPath)) throw new Error('Ungültiger Gerätepfad');
  if (!/^\/mnt\/[a-zA-Z0-9_-]+$/.test(mountPoint)) throw new Error('Mountpoint muss unter /mnt/<name> liegen.');

  fs.mkdirSync(mountPoint, { recursive: true });
  await execFileAsync('mount', [devPath, mountPoint], { timeout: 10000 });

  if (persistFstab && fs.existsSync('/host/etc/fstab')) {
    const fstab = fs.readFileSync('/host/etc/fstab', 'utf8');
    if (!fstab.includes(mountPoint)) {
      fs.appendFileSync('/host/etc/fstab', `\n${devPath} ${mountPoint} auto defaults,nofail 0 2\n`);
    }
  }
  return { ok: true, devPath, mountPoint };
}

async function unmountHostPath(mountPoint) {
  if (!ALLOW_STORAGE_ADMIN) {
    throw new Error('Festplatten-Verwaltung erfordert ALLOW_STORAGE_ADMIN=true.');
  }
  if (!/^\/(mnt|media)\/[a-zA-Z0-9_/-]+$/.test(mountPoint)) {
    throw new Error('Nur Mountpoints unter /mnt oder /media können ausgehängt werden.');
  }
  await execFileAsync('umount', [mountPoint], { timeout: 10000 });
  return { ok: true };
}

async function formatHostDevice(devPath, fsType = 'ext4', label = 'homeserver') {
  if (!ALLOW_STORAGE_ADMIN) {
    throw new Error('Formatierung erfordert ALLOW_STORAGE_ADMIN=true und privileged: true.');
  }
  if (!/^\/dev\/[a-zA-Z0-9_-]+$/.test(devPath)) throw new Error('Ungültiger Gerätepfad');
  if (!['ext4', 'xfs'].includes(fsType)) throw new Error('Nur ext4 oder xfs unterstützt.');
  const cleanLabel = String(label || 'data').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  const args = fsType === 'ext4' ? ['-F', '-L', cleanLabel, devPath] : ['-f', '-L', cleanLabel, devPath];
  await execFileAsync(`mkfs.${fsType}`, args, { timeout: 60000 });
  return { ok: true, devPath, fsType };
}

function guessDefaultLabel(mountpoint) {
  if (mountpoint === '/' || mountpoint === '/host') return 'System & Root';
  const base = path.basename(mountpoint);
  if (/foto|photo|immich|pic/i.test(base)) return 'Fotos & Mediathek';
  if (/video|film|movie|jellyfin|plex|serien|media/i.test(base)) return 'Videos & Medien';
  if (/music|musik|audio/i.test(base)) return 'Musik & Audio';
  if (/backup|sicherung|timemachine|duplicati/i.test(base)) return 'Backups & Archiv';
  if (/cloud|nextcloud|data|daten/i.test(base)) return 'Daten & Cloud';
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Datenträger';
}

async function collectStorageMetrics(customLabels = {}) {
  const [dfEntries, blockDevices] = await Promise.all([runDf(), runLsblk()]);
  const ioRates = getDiskIoRates();
  const smartByDevice = await querySmartInfo(blockDevices);
  const allowlist = getConfiguredMountAllowlist();

  const seenMounts = new Set();
  const seenFilesystems = new Set();
  const disks = [];

  for (const entry of dfEntries) {
    const mp = entry.mountpoint;
    const fsType = (entry.fsType || '').toLowerCase();

    if (!mp || entry.totalBytes <= 0) continue;
    if (seenMounts.has(mp)) continue;

    const explicitlyAllowed = allowlist.some((prefix) => mp === prefix || mp.startsWith(prefix + '/'));
    const isMediaSubmount = /^\/(mnt|media|disks|storage|pool|data|host\/mnt|host\/media)\/[^/]+/i.test(mp);

    if (!explicitlyAllowed && !(isMediaSubmount && !IGNORED_FS.has(fsType))) {
      if (IGNORED_FS.has(fsType)) continue;
      if (IGNORED_MOUNT_PREFIXES.some((p) => mp.startsWith(p))) continue;
      if (fsType === 'virtiofs' && mp === '/shared') continue;
    }

    // Deduplicate identical physical filesystems mounted multiple times unless explicitly requested
    const dedupKey = `${entry.filesystem}:${entry.totalBytes}`;
    if (!explicitlyAllowed && !isMediaSubmount && entry.filesystem.startsWith('/dev/') && seenFilesystems.has(dedupKey)) {
      continue;
    }

    seenMounts.add(mp);
    seenFilesystems.add(dedupKey);

    const devBase = path.basename(entry.filesystem);
    const lsblkMatch = blockDevices.find(
      (b) => b.devPath === entry.filesystem || b.name === devBase || b.mountpoint === mp
    );

    const parentName = lsblkMatch?.parentName || devBase.replace(/p?\d+$/, '');
    const io = ioRates[devBase] || ioRates[parentName] || { readBytesPerSec: 0, writeBytesPerSec: 0 };
    const smart = smartByDevice[parentName] || smartByDevice[devBase] || null;

    const usedPercent = entry.totalBytes > 0
      ? Math.round((entry.usedBytes / entry.totalBytes) * 1000) / 10
      : 0;

    const labelKey = mp;
    const label = customLabels[labelKey] || customLabels[entry.filesystem] || guessDefaultLabel(mp);

    disks.push({
      id: mp,
      label,
      device: entry.filesystem,
      mountpoint: mp,
      fsType: entry.fsType || lsblkMatch?.fstype || 'ext4',
      diskType: classifyDiskType(lsblkMatch, fsType, mp),
      model: lsblkMatch?.model || null,
      totalBytes: entry.totalBytes,
      usedBytes: entry.usedBytes,
      availableBytes: entry.availBytes,
      usedPercent,
      readBytesPerSec: io.readBytesPerSec,
      writeBytesPerSec: io.writeBytesPerSec,
      temperatureCelsius: smart?.temperatureCelsius ?? null,
      smartStatus: smart?.status ?? 'Aktiv',
      healthy: smart?.healthy ?? usedPercent < 95,
      powerOnHours: smart?.powerOnHours ?? null
    });
  }

  // Sort: System root first, then mounted media drives by capacity descending
  disks.sort((a, b) => {
    if (a.mountpoint === '/' || a.mountpoint === '/host') return -1;
    if (b.mountpoint === '/' || b.mountpoint === '/host') return 1;
    return b.totalBytes - a.totalBytes;
  });

  const totals = disks.reduce(
    (acc, d) => {
      acc.totalBytes += d.totalBytes;
      acc.usedBytes += d.usedBytes;
      acc.availableBytes += d.availableBytes;
      acc.readBytesPerSec += d.readBytesPerSec;
      acc.writeBytesPerSec += d.writeBytesPerSec;
      return acc;
    },
    { totalBytes: 0, usedBytes: 0, availableBytes: 0, readBytesPerSec: 0, writeBytesPerSec: 0 }
  );

  totals.usedPercent = totals.totalBytes > 0
    ? Math.round((totals.usedBytes / totals.totalBytes) * 1000) / 10
    : 0;

  const unmountedDevices = blockDevices
    .filter((d) => {
      if (d.type !== 'disk') return false;
      if (d.name.startsWith('loop') || d.name.startsWith('ram') || d.name.startsWith('zram')) return false;
      const hasAnyMount = blockDevices.some(
        (child) => (child.name === d.name || child.parentName === d.name) && Boolean(child.mountpoint)
      );
      return !hasAnyMount && d.sizeBytes > 0;
    })
    .map((d) => ({
      name: d.name,
      devPath: d.devPath,
      sizeBytes: d.sizeBytes,
      model: d.model || 'Unbekanntes Laufwerk',
      diskType: classifyDiskType(d, '', ''),
      tran: d.tran || 'sata'
    }));

  return {
    allowAdmin: ALLOW_STORAGE_ADMIN,
    disks,
    unmountedDevices,
    totals,
    diskCount: disks.length,
    healthyCount: disks.filter((d) => d.healthy && d.usedPercent < 90).length,
    warningCount: disks.filter((d) => !d.healthy || d.usedPercent >= 90).length
  };
}

module.exports = {
  collectStorageMetrics,
  mountHostDevice,
  unmountHostPath,
  formatHostDevice
};
