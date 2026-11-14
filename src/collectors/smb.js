const fs = require('node:fs');
const path = require('node:path');
const { createAndStartContainer, removeContainer, collectDockerContainers } = require('./docker');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SMB_FILE = path.join(DATA_DIR, 'smb-shares.json');
const CONTAINER_NAME = 'samba-homeserver';

function loadSmbConfig() {
  if (!fs.existsSync(SMB_FILE)) {
    return {
      username: 'homeserver',
      password: '',
      shares: []
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

async function getSmbStatus() {
  const config = loadSmbConfig();
  const docker = await collectDockerContainers();
  const match = (docker.containers || []).find((c) => c.name === CONTAINER_NAME);
  const containerRunning = Boolean(match && match.state === 'running');

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

async function applySmbShares(nextConfig) {
  const existing = loadSmbConfig();
  const merged = saveSmbConfig({
    username: nextConfig.username || existing.username,
    password: nextConfig.password !== undefined && nextConfig.password !== '' ? nextConfig.password : existing.password,
    shares: nextConfig.shares || existing.shares
  });

  if (merged.shares.length === 0) {
    try { await removeContainer(CONTAINER_NAME, true); } catch { /* ignore if absent */ }
    return { ok: true, running: false, shares: [] };
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
    const readonly = s.readOnly ? 'yes' : 'no';
    const guest = merged.password ? 'no' : 'yes';
    const users = merged.password ? merged.username : 'all';
    // dperson/samba SHARE format: name;/path;browseable;readonly;guest;users
    env.push({
      key: `SHARE${idx + 1}`,
      value: `${s.name};/shares/${s.id};yes;${readonly};${guest};${users}`
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
