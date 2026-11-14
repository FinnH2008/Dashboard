const fs = require('node:fs');
const http = require('node:http');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const ALLOW_CONTROL = String(process.env.ALLOW_DOCKER_CONTROL || 'false').toLowerCase() === 'true';

const statsCache = new Map();

function dockerRequest(method, apiPath, timeoutMs = 3000, bodyObj = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('DOCKER_SOCKET_MISSING'));
    }

    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = payload
      ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      : {};

    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: apiPath,
        method,
        headers,
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`Docker API ${res.statusCode}: ${buffer.toString('utf8')}`));
          }
          resolve({ statusCode: res.statusCode, buffer });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Docker API Zeitüberschreitung'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerJson(method, apiPath, timeoutMs = 3000, bodyObj = null) {
  const { buffer } = await dockerRequest(method, apiPath, timeoutMs, bodyObj);
  if (!buffer.length) return null;
  return JSON.parse(buffer.toString('utf8'));
}

function calculateCpuPercent(stats) {
  if (!stats || !stats.cpu_stats || !stats.precpu_stats) return 0;
  const cpuDelta =
    (stats.cpu_stats.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats.cpu_usage?.total_usage || 0);
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage || 0) -
    (stats.precpu_stats.system_cpu_usage || 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage?.percpu_usage?.length ||
    1;

  if (systemDelta > 0 && cpuDelta > 0) {
    return Math.round(((cpuDelta / systemDelta) * onlineCpus * 100) * 10) / 10;
  }
  return 0;
}

function calculateMemUsage(stats) {
  if (!stats || !stats.memory_stats) {
    return { usedBytes: 0, limitBytes: 0, percent: 0 };
  }
  const usage = stats.memory_stats.usage || 0;
  const cache =
    stats.memory_stats.stats?.inactive_file ??
    stats.memory_stats.stats?.cache ??
    0;
  const usedBytes = Math.max(0, usage - cache);
  const limitBytes = stats.memory_stats.limit || 0;
  const percent = limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 0;
  return { usedBytes, limitBytes, percent };
}

function formatPorts(ports = []) {
  const seen = new Set();
  const list = [];
  for (const p of ports) {
    if (p.PublicPort) {
      const label = `${p.PublicPort}:${p.PrivatePort}/${p.Type || 'tcp'}`;
      if (!seen.has(label)) {
        seen.add(label);
        list.push({
          publicPort: p.PublicPort,
          privatePort: p.PrivatePort,
          type: p.Type || 'tcp',
          label: `${p.PublicPort} → ${p.PrivatePort}`
        });
      }
    }
  }
  return list;
}

async function fetchContainerStats(id) {
  const cached = statsCache.get(id);
  if (cached && Date.now() - cached.ts < 3500) {
    return cached.data;
  }
  try {
    const raw = await dockerJson('GET', `/containers/${id}/stats?stream=false`, 2500);
    const parsed = {
      cpuPercent: calculateCpuPercent(raw),
      memory: calculateMemUsage(raw)
    };
    statsCache.set(id, { ts: Date.now(), data: parsed });
    return parsed;
  } catch {
    return {
      cpuPercent: 0,
      memory: { usedBytes: 0, limitBytes: 0, percent: 0 }
    };
  }
}

async function collectDockerContainers() {
  if (!fs.existsSync(DOCKER_SOCKET)) {
    return {
      available: false,
      allowControl: ALLOW_CONTROL,
      reason: 'Docker Socket (/var/run/docker.sock) ist nicht gemountet.',
      summary: { total: 0, running: 0, stopped: 0, unhealthy: 0 },
      containers: []
    };
  }

  try {
    const rawList = await dockerJson('GET', '/containers/json?all=true', 3000);
    const runningIds = rawList.filter((c) => c.State === 'running').map((c) => c.Id);

    const statsById = {};
    const batchSize = 6;
    for (let i = 0; i < runningIds.length; i += batchSize) {
      const batch = runningIds.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((id) => fetchContainerStats(id)));
      batch.forEach((id, idx) => {
        statsById[id] = results[idx];
      });
    }

    const containers = rawList.map((c) => {
      const name = (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '');
      const stats = statsById[c.Id] || {
        cpuPercent: 0,
        memory: { usedBytes: 0, limitBytes: 0, percent: 0 }
      };
      const statusLower = (c.Status || '').toLowerCase();
      const health = statusLower.includes('(healthy)')
        ? 'healthy'
        : statusLower.includes('(unhealthy)')
        ? 'unhealthy'
        : statusLower.includes('(starting)')
        ? 'starting'
        : null;

      return {
        id: c.Id.slice(0, 12),
        fullId: c.Id,
        name,
        stackName: c.Labels?.['com.docker.compose.project'] || c.Labels?.['io.portainer.stack.name'] || null,
        image: c.Image,
        state: c.State,
        statusText: c.Status,
        health,
        created: new Date(c.Created * 1000).toISOString(),
        ports: formatPorts(c.Ports),
        cpuPercent: stats.cpuPercent,
        memoryBytes: stats.memory.usedBytes,
        memoryLimitBytes: stats.memory.limitBytes,
        memoryPercent: stats.memory.percent
      };
    });

    containers.sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return a.name.localeCompare(b.name);
    });

    const running = containers.filter((c) => c.state === 'running').length;
    const unhealthy = containers.filter((c) => c.health === 'unhealthy').length;

    return {
      available: true,
      allowControl: ALLOW_CONTROL,
      reason: null,
      summary: {
        total: containers.length,
        running,
        stopped: containers.length - running,
        unhealthy
      },
      containers
    };
  } catch (err) {
    return {
      available: false,
      allowControl: ALLOW_CONTROL,
      reason: `Docker API nicht erreichbar: ${err.message}`,
      summary: { total: 0, running: 0, stopped: 0, unhealthy: 0 },
      containers: []
    };
  }
}

function decodeDockerLogs(buffer) {
  const lines = [];
  let offset = 0;
  let multiplexed = true;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    if (streamType !== 1 && streamType !== 2 && streamType !== 0) {
      multiplexed = false;
      break;
    }
    const frameSize = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + frameSize > buffer.length) {
      lines.push(buffer.slice(offset).toString('utf8'));
      break;
    }
    lines.push(buffer.slice(offset, offset + frameSize).toString('utf8'));
    offset += frameSize;
  }

  if (!multiplexed) return buffer.toString('utf8');
  return lines.join('');
}

async function getContainerLogs(containerId, tail = 120) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) throw new Error('Ungültige Container-ID');
  const { buffer } = await dockerRequest(
    'GET',
    `/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`,
    3500
  );
  return decodeDockerLogs(buffer);
}

async function controlContainer(containerId, action) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert (ALLOW_DOCKER_CONTROL=true setzen).');
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Ungültige Aktion');
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) throw new Error('Ungültige Container-ID');
  await dockerRequest('POST', `/containers/${containerId}/${action}`, 15000);
  statsCache.delete(containerId);
  return { ok: true };
}

async function removeContainer(containerId, force = true) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) throw new Error('Ungültige Container-ID');
  await dockerRequest('DELETE', `/containers/${containerId}?force=${force ? 'true' : 'false'}`, 10000);
  statsCache.delete(containerId);
  return { ok: true };
}

async function pullImage(image) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert.');
  const lastPart = image.split('/').pop();
  const fullImage = lastPart && lastPart.includes(':') ? image : `${image}:latest`;
  await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(fullImage)}`, 300_000);
  return fullImage;
}

async function inspectContainerConfig(containerId) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) throw new Error('Ungültige Container-ID');
  const info = await dockerJson('GET', `/containers/${containerId}/json`, 4000);

  const ports = [];
  const portBindings = info.HostConfig?.PortBindings || {};
  for (const [key, bindings] of Object.entries(portBindings)) {
    const [cPort, proto] = key.split('/');
    if (Array.isArray(bindings) && bindings[0]?.HostPort) {
      ports.push({
        hostPort: bindings[0].HostPort,
        containerPort: cPort,
        protocol: proto || 'tcp'
      });
    }
  }

  const volumes = (info.HostConfig?.Binds || []).map((b) => {
    const parts = b.split(':');
    return {
      hostPath: parts[0] || '',
      containerPath: parts[1] || ''
    };
  });

  const env = (info.Config?.Env || []).map((line) => {
    const idx = line.indexOf('=');
    return {
      key: idx > 0 ? line.slice(0, idx) : line,
      value: idx > 0 ? line.slice(idx + 1) : ''
    };
  });

  const devices = (info.HostConfig?.Devices || []).map((d) =>
    d.PathOnHost === d.PathInContainer ? d.PathOnHost : `${d.PathOnHost}:${d.PathInContainer}`
  );

  return {
    id: info.Id.slice(0, 12),
    name: (info.Name || '').replace(/^\//, ''),
    image: info.Config?.Image || '',
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'unless-stopped',
    networkMode: info.HostConfig?.NetworkMode || 'bridge',
    privileged: Boolean(info.HostConfig?.Privileged),
    devices,
    ports,
    volumes,
    env
  };
}

async function createAndStartContainer({
  name,
  image,
  hostPort,
  containerPort,
  ports = [],
  volumes = [],
  env = [],
  restartPolicy = 'unless-stopped',
  networkMode = 'bridge',
  privileged = false,
  devices = [],
  skipPull = false
}) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert (ALLOW_DOCKER_CONTROL=true setzen).');
  const cleanName = String(name || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '-');
  if (!cleanName || !image) throw new Error('Container-Name und Image sind erforderlich.');

  const fullImage = skipPull ? image.trim() : await pullImage(image.trim());

  const allPorts = [...ports];
  if (hostPort && containerPort) {
    allPorts.push({ hostPort: String(hostPort), containerPort: String(containerPort), protocol: 'tcp' });
  }

  const exposedPorts = {};
  const portBindings = {};
  if (networkMode !== 'host') {
    for (const p of allPorts) {
      if (!p.hostPort || !p.containerPort) continue;
      const key = `${p.containerPort}/${p.protocol || 'tcp'}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.hostPort) }];
    }
  }

  const binds = volumes
    .filter((v) => v.hostPath && v.containerPath)
    .map((v) => `${v.hostPath.trim()}:${v.containerPath.trim()}`);

  const envList = env
    .filter((e) => e.key)
    .map((e) => `${e.key.trim()}=${e.value ?? ''}`);

  const parsedDevices = (devices || [])
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .map((d) => {
      const [hostDev, contDev] = d.split(':');
      return {
        PathOnHost: hostDev,
        PathInContainer: contDev || hostDev,
        CgroupPermissions: 'rwm'
      };
    });

  const createPayload = {
    Image: fullImage,
    Env: envList,
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: binds,
      PortBindings: portBindings,
      NetworkMode: networkMode || 'bridge',
      Privileged: Boolean(privileged),
      Devices: parsedDevices,
      RestartPolicy: { Name: restartPolicy || 'unless-stopped' }
    }
  };

  const created = await dockerJson(
    'POST',
    `/containers/create?name=${encodeURIComponent(cleanName)}`,
    15000,
    createPayload
  );

  await dockerRequest('POST', `/containers/${created.Id}/start`, 15000);

  return {
    ok: true,
    id: created.Id.slice(0, 12),
    name: cleanName,
    image: fullImage
  };
}

async function recreateOrUpdateContainer(containerId, overrideConfig = null) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert.');
  const current = await inspectContainerConfig(containerId);
  const next = overrideConfig ? { ...current, ...overrideConfig } : current;

  // Pull newest image BEFORE destroying old container so failure doesn't lose running app
  const fullImage = await pullImage(next.image);
  await removeContainer(containerId, true);

  return await createAndStartContainer({
    ...next,
    image: fullImage,
    skipPull: true
  });
}

module.exports = {
  dockerRequest,
  dockerJson,
  collectDockerContainers,
  getContainerLogs,
  controlContainer,
  removeContainer,
  createAndStartContainer,
  inspectContainerConfig,
  recreateOrUpdateContainer
};
