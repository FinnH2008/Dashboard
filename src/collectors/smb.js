const fs = require('node:fs');
const path = require('node:path');
const { createAndStartContainer, removeContainer, collectDockerContainers } = require('./docker');
const { demoInstallContainer, demoRemoveContainer } = require('./demo');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SMB_FILE = path.join(DATA_DIR, 'smb-shares.json');
const CONTAINER_NAME = 'samba-homeserver';

function loadSmbConfig() {
  if (!fs.existsSync(SMB_FILE)) {
    return {
      username: 'homeserver',
      password: '',
      shares: [
        { id: 'fotos', name: 'Fotos', path: '/mnt/fotos', readOnly: false },
        { id: 'filme', name: 'Filme', path: '/mnt/filme', readOnly: true },
        { id: 'serien', name: 'Serien', path: '/mnt/serien', readOnly: true },
        { id: 'backup', name: 'Backup', path: '/mnt/backup', readOnly: false }
      ]
    };
  }
  try {
    return JSON.parse(fs.readFileSync(SMB_FILE, 'utf8'));
  } catch {
    return { username: 'homeserver', password: '', shares: [] };
  }
}

function saveSmbConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const clean = {
    username: String(cfg.username || 'homeserver').trim() || 'homeserver',
    password: String(cfg.password || ''),
    shares: Array.isArray(cfg.shares)
      ? cfg.shares
          .filter((s) => s.name && s.path)
          .map((s) => ({
            id: s.id || String(s.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            name: String(s.name).trim(),
            path: String(s.path).trim(),
            readOnly: Boolean(s.readOnly)
          }))
      : []
  };
  fs.writeFileSync(SMB_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

async function getSmbStatus(isDemo = false) {
  const config = loadSmbConfig();
  let containerRunning = false;

  if (isDemo) {
    containerRunning = true;
  } else {
    const docker = await collectDockerContainers();
    const match = (docker.containers || []).find((c) => c.name === CONTAINER_NAME);
    containerRunning = Boolean(match && match.state === 'running');
  }

  return {
    containerName: CONTAINER_NAME,
    running: containerRunning,
    config: {
      username: config.username,
      hasPassword: Boolean(config.password),
      shares: config.shares
    }
  };
}

async function applySmbShares(nextConfig, isDemo = false) {
  const existing = loadSmbConfig();
  const merged = saveSmbConfig({
    username: nextConfig.username || existing.username,
    password: nextConfig.password !== undefined && nextConfig.password !== '' ? nextConfig.password : existing.password,
    shares: nextConfig.shares || existing.shares
  });

  if (merged.shares.length === 0) {
    if (isDemo) demoRemoveContainer(CONTAINER_NAME);
    else {
      try { await removeContainer(CONTAINER_NAME, true); } catch { /* ignore if absent */ }
    }
    return { ok: true, running: false, shares: [] };
  }

  if (isDemo) {
    demoInstallContainer({
      name: CONTAINER_NAME,
      image: 'dperson/samba:latest',
      hostPort: 445,
      containerPort: 445
    });
    return { ok: true, running: true, shares: merged.shares };
  }

  const volumes = merged.shares.map((s) => ({
    hostPath: s.path,
    containerPath: `/shares/${s.id}`
  }));

  const env = [
    { key: 'TZ', value: 'Europe/Berlin' },
    { key: 'USERID', value: '1000' },
    { key: 'GROUPID', value: '1000' },
    { key: 'PERMISSIONS', value: 'true' }
  ];

  if (merged.password) {
    env.push({ key: 'USER', value: `${merged.username};${merged.password}` });
  }

  merged.shares.forEach((s, idx) => {
    const rw = s.readOnly ? 'no' : 'yes';
    const guest = merged.password ? 'no' : 'yes';
    const userAccess = merged.password ? `;${merged.username}` : '';
    // dperson/samba SHARE format: name;/path;browseable;readonly;guest;users
    env.push({
      key: `SHARE${idx + 1}`,
      value: `${s.name};/shares/${s.id};yes;${s.readOnly ? 'yes' : 'no'};${guest};${rw === 'yes' ? 'all' : 'none'}${userAccess}`
    });
  });

  try {
    await removeContainer(CONTAINER_NAME, true);
  } catch {
    // ignore if container does not exist yet
  }

  await createAndStartContainer({
    name: CONTAINER_NAME,
    image: 'dperson/samba:latest',
    ports: [
      { hostPort: 139, containerPort: 139, protocol: 'tcp' },
      { hostPort: 445, containerPort: 445, protocol: 'tcp' }
    ],
    volumes,
    env,
    restartPolicy: 'unless-stopped'
  });

  return { ok: true, running: true, shares: merged.shares };
}

module.exports = {
  getSmbStatus,
  applySmbShares
};
