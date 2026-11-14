const os = require('node:os');

let tick = 0;

function wave(base, amp, speed = 1, phase = 0) {
  return Math.max(0, base + Math.sin(tick * speed + phase) * amp + Math.cos(tick * speed * 0.43 + phase) * (amp * 0.4));
}

let demoContainers = [
  {
    id: 'a1b2c3d4e501',
    name: 'immich-server',
    image: 'ghcr.io/immich-app/immich-server:release',
    state: 'running',
    statusText: 'Up 19 days (healthy)',
    health: 'healthy',
    ports: [{ publicPort: 2283, privatePort: 2283, type: 'tcp', label: '2283 → 2283' }],
    baseCpu: 6.4,
    memoryBytes: 1.85 * 1024 ** 3,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 5.8
  },
  {
    id: 'a1b2c3d4e502',
    name: 'immich-machine-learning',
    image: 'ghcr.io/immich-app/immich-machine-learning:release',
    state: 'running',
    statusText: 'Up 19 days (healthy)',
    health: 'healthy',
    ports: [],
    baseCpu: 4.1,
    memoryBytes: 2.4 * 1024 ** 3,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 7.5
  },
  {
    id: 'a1b2c3d4e503',
    name: 'jellyfin',
    image: 'lscr.io/linuxserver/jellyfin:latest',
    state: 'running',
    statusText: 'Up 38 days (healthy)',
    health: 'healthy',
    ports: [{ publicPort: 8096, privatePort: 8096, type: 'tcp', label: '8096 → 8096' }],
    baseCpu: 9.2,
    memoryBytes: 1.42 * 1024 ** 3,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 4.4
  },
  {
    id: 'a1b2c3d4e504',
    name: 'nextcloud',
    image: 'nextcloud:29-apache',
    state: 'running',
    statusText: 'Up 38 days',
    health: null,
    ports: [{ publicPort: 8080, privatePort: 80, type: 'tcp', label: '8080 → 80' }],
    baseCpu: 1.4,
    memoryBytes: 680 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 2.1
  },
  {
    id: 'a1b2c3d4e505',
    name: 'paperless-ngx',
    image: 'ghcr.io/paperless-ngx/paperless-ngx:latest',
    state: 'running',
    statusText: 'Up 24 days (healthy)',
    health: 'healthy',
    ports: [{ publicPort: 8000, privatePort: 8000, type: 'tcp', label: '8000 → 8000' }],
    baseCpu: 0.4,
    memoryBytes: 510 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 1.6
  },
  {
    id: 'a1b2c3d4e506',
    name: 'postgres-media',
    image: 'tensorchord/pgvecto-rs:pg16-v0.2.0',
    state: 'running',
    statusText: 'Up 38 days (healthy)',
    health: 'healthy',
    ports: [],
    baseCpu: 0.8,
    memoryBytes: 420 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 1.3
  },
  {
    id: 'a1b2c3d4e507',
    name: 'traefik',
    image: 'traefik:v3.1',
    state: 'running',
    statusText: 'Up 38 days',
    health: null,
    ports: [
      { publicPort: 80, privatePort: 80, type: 'tcp', label: '80 → 80' },
      { publicPort: 443, privatePort: 443, type: 'tcp', label: '443 → 443' }
    ],
    baseCpu: 0.3,
    memoryBytes: 92 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 0.3
  },
  {
    id: 'a1b2c3d4e508',
    name: 'adguardhome',
    image: 'adguard/adguardhome:latest',
    state: 'running',
    statusText: 'Up 38 days',
    health: null,
    ports: [
      { publicPort: 53, privatePort: 53, type: 'udp', label: '53 → 53' },
      { publicPort: 3000, privatePort: 3000, type: 'tcp', label: '3000 → 3000' }
    ],
    baseCpu: 0.5,
    memoryBytes: 185 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 0.6
  },
  {
    id: 'a1b2c3d4e509',
    name: 'portainer',
    image: 'portainer/portainer-ce:latest',
    state: 'running',
    statusText: 'Up 38 days',
    health: null,
    ports: [{ publicPort: 9000, privatePort: 9000, type: 'tcp', label: '9000 → 9000' }],
    baseCpu: 0.1,
    memoryBytes: 64 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 0.2
  },
  {
    id: 'a1b2c3d4e510',
    name: 'duplicati-backup',
    image: 'lscr.io/linuxserver/duplicati:latest',
    state: 'exited',
    statusText: 'Exited (0) 6 hours ago',
    health: null,
    ports: [{ publicPort: 8200, privatePort: 8200, type: 'tcp', label: '8200 → 8200' }],
    baseCpu: 0,
    memoryBytes: 0,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 0
  }
];

function demoControlContainer(id, action) {
  const c = demoContainers.find((item) => item.id === id || item.name === id);
  if (!c) throw new Error('Container nicht gefunden');
  if (action === 'stop') {
    c.state = 'exited';
    c.statusText = 'Exited (0) just now';
    c.health = null;
  } else if (action === 'start' || action === 'restart') {
    c.state = 'running';
    c.statusText = 'Up a few seconds (healthy)';
    c.health = 'healthy';
    if (c.memoryBytes === 0) c.memoryBytes = 140 * 1024 ** 2;
  }
  return { ok: true };
}

function demoRemoveContainer(id) {
  demoContainers = demoContainers.filter((item) => item.id !== id && item.name !== id);
  return { ok: true };
}

function demoInstallContainer({ name, image, hostPort, containerPort }) {
  const cleanName = String(name || 'custom-app').trim();
  const id = `demo-${Date.now().toString(16)}`;
  const ports = hostPort && containerPort
    ? [{ publicPort: Number(hostPort), privatePort: Number(containerPort), type: 'tcp', label: `${hostPort} → ${containerPort}` }]
    : [];
  demoContainers.unshift({
    id,
    name: cleanName,
    image,
    state: 'running',
    statusText: 'Up a few seconds',
    health: null,
    ports,
    baseCpu: 1.2,
    memoryBytes: 180 * 1024 ** 2,
    memoryLimitBytes: 32 * 1024 ** 3,
    memoryPercent: 0.6
  });
  return { ok: true, id, name: cleanName, image };
}

function demoInspectContainer(id) {
  const c = demoContainers.find((item) => item.id === id || item.name === id);
  if (!c) throw new Error('Container nicht gefunden');
  return {
    id: c.id,
    name: c.name,
    image: c.image,
    restartPolicy: 'unless-stopped',
    networkMode: 'bridge',
    privileged: false,
    devices: [],
    ports: (c.ports || []).map((p) => ({
      hostPort: String(p.publicPort),
      containerPort: String(p.privatePort),
      protocol: p.type || 'tcp'
    })),
    volumes: [{ hostPath: '/mnt/fotos', containerPath: '/data' }],
    env: [{ key: 'TZ', value: 'Europe/Berlin' }]
  };
}

function demoUpdateContainer(id, overrideConfig = null) {
  const c = demoContainers.find((item) => item.id === id || item.name === id);
  if (!c) throw new Error('Container nicht gefunden');
  if (overrideConfig) {
    if (overrideConfig.name) c.name = overrideConfig.name;
    if (overrideConfig.image) c.image = overrideConfig.image;
    if (Array.isArray(overrideConfig.ports)) {
      c.ports = overrideConfig.ports
        .filter((p) => p.hostPort && p.containerPort)
        .map((p) => ({
          publicPort: Number(p.hostPort),
          privatePort: Number(p.containerPort),
          type: p.protocol || 'tcp',
          label: `${p.hostPort} → ${p.containerPort}`
        }));
    }
  }
  c.state = 'running';
  c.statusText = 'Up a few seconds (aktualisiert)';
  return { ok: true, id: c.id, name: c.name, image: c.image };
}

let demoUnmounted = [
  {
    name: 'sde',
    devPath: '/dev/sde',
    sizeBytes: 16 * 1000 ** 4,
    model: 'Seagate Exos X18 16TB',
    diskType: 'SATA HDD',
    tran: 'sata'
  }
];
const demoExtraDisks = [];

function demoMountDevice(devPath, mountPoint) {
  const idx = demoUnmounted.findIndex((d) => d.devPath === devPath);
  if (idx >= 0) {
    const dev = demoUnmounted.splice(idx, 1)[0];
    demoExtraDisks.push({
      id: mountPoint,
      defaultLabel: 'Neues Laufwerk',
      device: devPath,
      mountpoint: mountPoint,
      fsType: 'ext4',
      diskType: dev.diskType,
      model: dev.model,
      totalBytes: dev.sizeBytes,
      usedBytes: 120 * 1024 ** 2,
      readBytesPerSec: 0,
      writeBytesPerSec: 0,
      temperatureCelsius: 33,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 12
    });
  }
  return { ok: true, devPath, mountPoint };
}

function getDemoSnapshot(customLabels = {}, customServerName = 'Heimserver NAS') {
  tick += 1;

  const cpuUsage = Math.round(wave(24, 11, 0.35, 0) * 10) / 10;
  const cores = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => ({
    core: c,
    percent: Math.min(100, Math.round(wave(18 + (c % 3) * 8, 15, 0.4, c * 0.8) * 10) / 10)
  }));

  const ramTotal = 32 * 1024 ** 3;
  const ramUsed = Math.round(14.8 * 1024 ** 3 + wave(0.6 * 1024 ** 3, 0.35 * 1024 ** 3, 0.2));
  const ramCached = 9.4 * 1024 ** 3;

  const rxRate = Math.round(wave(18.5, 14.2, 0.45, 0.2) * 1024 * 1024);
  const txRate = Math.round(wave(42.0, 26.0, 0.32, 1.4) * 1024 * 1024);

  const system = {
    allowPower: true,
    hostname: customServerName || 'homeserver-nas',
    rawHostname: 'homeserver-nas',
    os: 'Debian GNU/Linux 12 (bookworm)',
    kernel: '6.1.0-28-amd64',
    arch: 'x64',
    ipAddress: '192.168.178.42',
    uptimeSeconds: 38 * 86400 + 14 * 3600 + 27 * 60 + tick * 2,
    cpu: {
      model: 'AMD Ryzen 5 5600G with Radeon Graphics',
      coresCount: 12,
      usagePercent: cpuUsage,
      perCore: cores,
      loadAvg: [
        Math.round(wave(1.45, 0.45, 0.25) * 100) / 100,
        Math.round(wave(1.32, 0.2, 0.15) * 100) / 100,
        1.18
      ],
      temperatureCelsius: Math.round(wave(44, 3.2, 0.18) * 10) / 10
    },
    memory: {
      totalBytes: ramTotal,
      usedBytes: ramUsed,
      availableBytes: ramTotal - ramUsed,
      cachedBytes: ramCached,
      swapTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 128 * 1024 ** 2,
      usedPercent: Math.round((ramUsed / ramTotal) * 1000) / 10
    },
    temperatures: {
      cpuCelsius: Math.round(wave(44, 3.2, 0.18) * 10) / 10,
      sensors: [
        { label: 'CPU Package (k10temp)', celsius: Math.round(wave(44, 3.2, 0.18) * 10) / 10 },
        { label: 'Mainboard Chipsatz', celsius: 37.5 },
        { label: 'NVMe System SSD', celsius: 39.0 }
      ]
    },
    network: {
      rxBytesPerSec: rxRate,
      txBytesPerSec: txRate,
      interfaces: [
        {
          name: 'enp4s0 (2.5 GbE)',
          rxBytesPerSec: rxRate,
          txBytesPerSec: txRate,
          totalRxBytes: 4.82 * 1024 ** 4,
          totalTxBytes: 11.45 * 1024 ** 4
        }
      ]
    },
    timestamp: new Date().toISOString()
  };

  const TB = 1000 ** 4;
  const TiB = 1024 ** 4;
  const rawDisks = [
    {
      id: '/',
      defaultLabel: 'System & Docker SSD',
      device: '/dev/nvme0n1p2',
      mountpoint: '/',
      fsType: 'ext4',
      diskType: 'NVMe SSD',
      model: 'Samsung 980 PRO 1TB',
      totalBytes: 1 * TiB,
      usedBytes: 312 * 1024 ** 3,
      readBytesPerSec: Math.round(wave(8, 5, 0.5) * 1024 * 1024),
      writeBytesPerSec: Math.round(wave(14, 9, 0.6) * 1024 * 1024),
      temperatureCelsius: 39,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 8940
    },
    {
      id: '/mnt/fotos',
      defaultLabel: 'Fotos & Immich RAWs',
      device: '/dev/sda1',
      mountpoint: '/mnt/fotos',
      fsType: 'btrfs',
      diskType: 'SATA HDD',
      model: 'WD Red Plus 8TB',
      totalBytes: 8 * TB,
      usedBytes: 4.82 * TB,
      readBytesPerSec: Math.round(wave(22, 16, 0.35, 1) * 1024 * 1024),
      writeBytesPerSec: Math.round(wave(4.2, 3.8, 0.4, 2) * 1024 * 1024),
      temperatureCelsius: 35,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 14210
    },
    {
      id: '/mnt/filme',
      defaultLabel: 'Filme & 4K-Videos',
      device: '/dev/sdb1',
      mountpoint: '/mnt/filme',
      fsType: 'ext4',
      diskType: 'SATA HDD',
      model: 'Seagate IronWolf 12TB',
      totalBytes: 12 * TB,
      usedBytes: 9.84 * TB,
      readBytesPerSec: Math.round(wave(54, 24, 0.28, 0.5) * 1024 * 1024),
      writeBytesPerSec: Math.round(wave(1.5, 1.2, 0.3, 1.2) * 1024 * 1024),
      temperatureCelsius: 37,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 11850
    },
    {
      id: '/mnt/serien',
      defaultLabel: 'Serien, Musik & Aufnahmen',
      device: '/dev/sdc1',
      mountpoint: '/mnt/serien',
      fsType: 'ext4',
      diskType: 'SATA HDD',
      model: 'Seagate IronWolf 8TB',
      totalBytes: 8 * TB,
      usedBytes: 5.18 * TB,
      readBytesPerSec: Math.round(wave(12, 8, 0.42, 2.2) * 1024 * 1024),
      writeBytesPerSec: Math.round(wave(2.1, 1.8, 0.37, 0.4) * 1024 * 1024),
      temperatureCelsius: 34,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 9620
    },
    {
      id: '/mnt/backup',
      defaultLabel: 'Nextcloud & Duplicati Backup',
      device: '/dev/sdd1',
      mountpoint: '/mnt/backup',
      fsType: 'zfs',
      diskType: 'SATA HDD',
      model: 'Toshiba N300 4TB',
      totalBytes: 4 * TB,
      usedBytes: 3.58 * TB,
      readBytesPerSec: Math.round(wave(1.2, 1.0, 0.2, 1.5) * 1024 * 1024),
      writeBytesPerSec: Math.round(wave(6.5, 5.2, 0.33, 0.8) * 1024 * 1024),
      temperatureCelsius: 36,
      smartStatus: 'Gesund',
      healthy: true,
      powerOnHours: 18430
    }
  ];

  const allRawDisks = [...rawDisks, ...demoExtraDisks];

  const disks = allRawDisks.map((d) => ({
    id: d.id,
    label: customLabels[d.mountpoint] || customLabels[d.device] || d.defaultLabel,
    device: d.device,
    mountpoint: d.mountpoint,
    fsType: d.fsType,
    diskType: d.diskType,
    model: d.model,
    totalBytes: d.totalBytes,
    usedBytes: d.usedBytes,
    availableBytes: d.totalBytes - d.usedBytes,
    usedPercent: Math.round((d.usedBytes / d.totalBytes) * 1000) / 10,
    readBytesPerSec: d.readBytesPerSec,
    writeBytesPerSec: d.writeBytesPerSec,
    temperatureCelsius: d.temperatureCelsius,
    smartStatus: d.smartStatus,
    healthy: d.healthy,
    powerOnHours: d.powerOnHours
  }));

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
  totals.usedPercent = Math.round((totals.usedBytes / totals.totalBytes) * 1000) / 10;

  const storage = {
    allowAdmin: true,
    disks,
    unmountedDevices: demoUnmounted,
    totals,
    diskCount: disks.length,
    healthyCount: disks.filter((d) => d.usedPercent < 90).length,
    warningCount: disks.filter((d) => d.usedPercent >= 90).length
  };

  const mediaCategories = [
    { id: 'videos', label: 'Videos & Filme', bytes: 12.6 * TB, count: 2480 },
    { id: 'photos', label: 'Fotos & RAW', bytes: 4.55 * TB, count: 148320 },
    { id: 'backups', label: 'Dokumente & Backups', bytes: 3.12 * TB, count: 42190 },
    { id: 'audio', label: 'Musik & Audio', bytes: 480 * 1000 ** 3, count: 31400 },
    { id: 'other', label: 'Sonstiges & Cache', bytes: 360 * 1000 ** 3, count: 8910 }
  ];
  const mediaTotalBytes = mediaCategories.reduce((s, c) => s + c.bytes, 0);
  const media = {
    configured: true,
    scannedPaths: ['/mnt/fotos', '/mnt/filme', '/mnt/serien', '/mnt/backup'],
    totalBytes: mediaTotalBytes,
    totalFiles: mediaCategories.reduce((s, c) => s + c.count, 0),
    truncated: false,
    scannedAt: new Date().toISOString(),
    categories: mediaCategories.map((c) => ({
      ...c,
      percent: Math.round((c.bytes / mediaTotalBytes) * 1000) / 10
    })),
    folders: [
      { path: '/mnt/filme', name: 'Filme & 4K-Archiv', bytes: 9.84 * TB, files: 1640, photosCount: 0, videosCount: 1640 },
      { path: '/mnt/fotos', name: 'Immich Fotos & Handy-Backup', bytes: 4.82 * TB, files: 148890, photosCount: 142100, videosCount: 6410 },
      { path: '/mnt/serien', name: 'Serien & Musikbibliothek', bytes: 5.18 * TB, files: 34210, photosCount: 4120, videosCount: 840 },
      { path: '/mnt/backup', name: 'Nextcloud & System-Backups', bytes: 3.58 * TB, files: 48560, photosCount: 2100, videosCount: 190 }
    ],
    recentFiles: [
      { name: 'Urlaub_Norwegen_4K.mp4', path: '/mnt/fotos/2026_Norwegen/Drohnenflug_Fjord_4K.mp4', category: 'videos', sizeBytes: 2.84 * 1024 ** 3, modifiedAt: new Date(Date.now() - 3600_000 * 3).toISOString() },
      { name: 'DSC_8492.ARW', path: '/mnt/fotos/2026_Norwegen/DSC_8492.ARW', category: 'photos', sizeBytes: 52.4 * 1024 ** 2, modifiedAt: new Date(Date.now() - 3600_000 * 5).toISOString() },
      { name: 'IMG_4921.HEIC', path: '/mnt/fotos/Handy_Backup/IMG_4921.HEIC', category: 'photos', sizeBytes: 4.1 * 1024 ** 2, modifiedAt: new Date(Date.now() - 3600_000 * 14).toISOString() },
      { name: 'Heimserver_Backup_2026-11.tar.zst', path: '/mnt/backup/Heimserver_Backup_2026-11.tar.zst', category: 'backups', sizeBytes: 18.2 * 1024 ** 3, modifiedAt: new Date(Date.now() - 86400_000).toISOString() }
    ]
  };

  const containers = demoContainers.map((c, idx) => ({
    ...c,
    stackName: c.name.startsWith('immich') || c.name === 'postgres-media' ? 'immich' : c.name === 'jellyfin' ? 'medien' : null,
    cpuPercent: c.state === 'running' ? Math.round(wave(c.baseCpu, c.baseCpu * 0.45, 0.35, idx * 0.7) * 10) / 10 : 0,
    memoryBytes: c.state === 'running' ? c.memoryBytes : 0,
    memoryPercent: c.state === 'running' ? c.memoryPercent : 0
  }));

  const docker = {
    available: true,
    allowControl: true,
    reason: null,
    summary: {
      total: containers.length,
      running: containers.filter((c) => c.state === 'running').length,
      stopped: containers.filter((c) => c.state !== 'running').length,
      unhealthy: 0
    },
    containers
  };

  return {
    mode: 'demo',
    system,
    storage,
    media,
    docker,
    meta: {
      osPlatform: os.platform(),
      generatedAt: new Date().toISOString()
    }
  };
}

function getDemoLogs(containerId) {
  const now = new Date();
  const ts = (offsetSec) => new Date(now.getTime() - offsetSec * 1000).toISOString();
  return [
    `${ts(180)} [INFO] Container ${containerId} initialisiert`,
    `${ts(142)} [INFO] Verbunden mit Medienpool /mnt/fotos und /mnt/filme`,
    `${ts(98)} [INFO] Index-Check abgeschlossen: 0 Fehler gefunden`,
    `${ts(45)} [INFO] Thumbnail-Worker bereit (4 Threads aktiv)`,
    `${ts(12)} [INFO] Healthcheck erfolgreich (200 OK, 4ms)`
  ].join('\n');
}

module.exports = {
  getDemoSnapshot,
  getDemoLogs,
  demoControlContainer,
  demoRemoveContainer,
  demoInstallContainer,
  demoInspectContainer,
  demoUpdateContainer,
  demoMountDevice
};
