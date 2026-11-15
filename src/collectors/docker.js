const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const ALLOW_CONTROL = String(process.env.ALLOW_DOCKER_CONTROL || 'false').toLowerCase() === 'true';

const statsCache = new Map();
const updateCheckCache = new Map(); // image -> { checkedAt, localDigests, remoteDigest, updateAvailable, error }
let lastUpdateCheckAt = null;
let dockerCacheLoadedFile = '';
let lastInventoryFlushTs = 0;
let lastSavedSummaryKey = '';

function getDockerCacheFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'docker-cache.json');
}

function loadDockerCache() {
  const file = getDockerCacheFile();
  if (dockerCacheLoadedFile === file) return;
  dockerCacheLoadedFile = file;
  try {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.lastUpdateCheckAt) lastUpdateCheckAt = parsed.lastUpdateCheckAt;
      if (parsed.updateChecks && typeof parsed.updateChecks === 'object') {
        updateCheckCache.clear();
        for (const [img, info] of Object.entries(parsed.updateChecks)) {
          if (info && typeof info === 'object') {
            updateCheckCache.set(img, info);
          }
        }
      }
    }
  } catch {
    // ignore corrupt cache file
  }
}

function saveDockerCache(summary = null) {
  const file = getDockerCacheFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const updateChecks = {};
    for (const [img, info] of updateCheckCache.entries()) {
      updateChecks[img] = info;
    }
    const payload = {
      savedAt: new Date().toISOString(),
      lastUpdateCheckAt,
      summary,
      updateChecks
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    lastInventoryFlushTs = Date.now();
  } catch {
    // ignore fs errors
  }
}

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

let statsRefreshInFlight = false;
let lastStatsRefreshTs = 0;
const STATS_REFRESH_MS = 5000;

let containerListCache = { ts: 0, rawList: null };
const CONTAINER_LIST_CACHE_MS = 2500;

function invalidateDockerListCache() {
  containerListCache = { ts: 0, rawList: null };
}

async function fetchContainerStats(id) {
  try {
    const raw = await dockerJson('GET', `/containers/${id}/stats?stream=false`, 2500);
    const parsed = {
      cpuPercent: calculateCpuPercent(raw),
      memory: calculateMemUsage(raw)
    };
    statsCache.set(id, { ts: Date.now(), data: parsed });
    return parsed;
  } catch {
    return statsCache.get(id)?.data || {
      cpuPercent: 0,
      memory: { usedBytes: 0, limitBytes: 0, percent: 0 }
    };
  }
}

function triggerStatsRefresh(runningIds) {
  const now = Date.now();
  if (statsRefreshInFlight || runningIds.length === 0 || now - lastStatsRefreshTs < STATS_REFRESH_MS) {
    return;
  }
  statsRefreshInFlight = true;
  lastStatsRefreshTs = now;
  (async () => {
    try {
      const batchSize = 4;
      for (let i = 0; i < runningIds.length; i += batchSize) {
        const batch = runningIds.slice(i, i + batchSize);
        await Promise.all(batch.map((id) => fetchContainerStats(id)));
      }
    } finally {
      statsRefreshInFlight = false;
    }
  })();
}

async function collectDockerContainers() {
  loadDockerCache();
  const nowIso = new Date().toISOString();

  if (!fs.existsSync(DOCKER_SOCKET)) {
    return {
      available: false,
      allowControl: ALLOW_CONTROL,
      reason: 'Docker Socket (/var/run/docker.sock) ist nicht gemountet.',
      collectedAt: nowIso,
      statsUpdatedAt: lastStatsRefreshTs ? new Date(lastStatsRefreshTs).toISOString() : null,
      lastUpdateCheckAt,
      summary: { total: 0, running: 0, stopped: 0, unhealthy: 0 },
      containers: []
    };
  }

  try {
    const now = Date.now();
    let rawList = null;
    if (containerListCache.rawList && now - containerListCache.ts < CONTAINER_LIST_CACHE_MS) {
      rawList = containerListCache.rawList;
    } else {
      rawList = await dockerJson('GET', '/containers/json?all=true', 2500);
      containerListCache = { ts: now, rawList };
    }

    const runningIds = rawList.filter((c) => c.State === 'running').map((c) => c.Id);
    triggerStatsRefresh(runningIds);

    const statsById = {};
    runningIds.forEach((id) => {
      const cached = statsCache.get(id);
      if (cached) statsById[id] = cached.data;
    });

    const activeIdSet = new Set(rawList.map((c) => c.Id));
    for (const cachedId of statsCache.keys()) {
      if (!activeIdSet.has(cachedId)) statsCache.delete(cachedId);
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

      const upd = updateCheckCache.get(c.Image) || null;
      return {
        id: c.Id.slice(0, 12),
        fullId: c.Id,
        name,
        stackName: c.Labels?.['com.docker.compose.project'] || c.Labels?.['io.portainer.stack.name'] || null,
        autohealLabel: c.Labels?.['com.homeserver.autoheal'] === 'true' || c.Labels?.autoheal === 'true',
        image: c.Image,
        state: c.State,
        statusText: c.Status,
        health,
        updateAvailable: Boolean(upd?.updateAvailable),
        updateCheckedAt: upd?.checkedAt || null,
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
    const summary = {
      total: containers.length,
      running,
      stopped: containers.length - running,
      unhealthy
    };

    const summaryKey = `${summary.total}:${summary.running}:${summary.unhealthy}`;
    if (summaryKey !== lastSavedSummaryKey || now - lastInventoryFlushTs >= 60_000) {
      lastSavedSummaryKey = summaryKey;
      saveDockerCache(summary);
    }

    return {
      available: true,
      allowControl: ALLOW_CONTROL,
      reason: null,
      collectedAt: nowIso,
      statsUpdatedAt: lastStatsRefreshTs ? new Date(lastStatsRefreshTs).toISOString() : null,
      lastUpdateCheckAt,
      summary,
      containers
    };
  } catch (err) {
    return {
      available: false,
      allowControl: ALLOW_CONTROL,
      reason: `Docker API nicht erreichbar: ${err.message}`,
      collectedAt: nowIso,
      statsUpdatedAt: lastStatsRefreshTs ? new Date(lastStatsRefreshTs).toISOString() : null,
      lastUpdateCheckAt,
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
  invalidateDockerListCache();
  return { ok: true };
}

async function removeContainer(containerId, force = true) {
  if (!ALLOW_CONTROL) throw new Error('Container-Steuerung ist deaktiviert.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) throw new Error('Ungültige Container-ID');
  await dockerRequest('DELETE', `/containers/${containerId}?force=${force ? 'true' : 'false'}`, 10000);
  statsCache.delete(containerId);
  invalidateDockerListCache();
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
      containerPath: parts[1] || '',
      mode: parts.slice(2).join(':') || ''
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
    env,
    labels: info.Config?.Labels || {},
    cmd: Array.isArray(info.Config?.Cmd) ? info.Config.Cmd : null,
    entrypoint: info.Config?.Entrypoint ?? null,
    capAdd: Array.isArray(info.HostConfig?.CapAdd) ? info.HostConfig.CapAdd : null
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
  labels = null,
  cmd = null,
  entrypoint = null,
  capAdd = null,
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
      const hp = Number(p.hostPort);
      const cp = Number(p.containerPort);
      if (!Number.isInteger(hp) || hp < 1 || hp > 65535 || !Number.isInteger(cp) || cp < 1 || cp > 65535) {
        const err = new Error(`Ungültiger Port: ${p.hostPort}:${p.containerPort}`);
        err.statusCode = 400;
        throw err;
      }
      const key = `${cp}/${p.protocol === 'udp' ? 'udp' : 'tcp'}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(hp) }];
    }
  }

  const binds = volumes
    .filter((v) => v.hostPath && v.containerPath)
    .map((v) => {
      const base = `${v.hostPath.trim()}:${v.containerPath.trim()}`;
      return v.mode ? `${base}:${v.mode.trim()}` : base;
    });

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

  if (labels && typeof labels === 'object' && Object.keys(labels).length > 0) {
    createPayload.Labels = labels;
  }
  if (Array.isArray(cmd) && cmd.length > 0) {
    createPayload.Cmd = cmd;
  }
  if (entrypoint !== null && entrypoint !== undefined) {
    createPayload.Entrypoint = entrypoint;
  }
  if (Array.isArray(capAdd) && capAdd.length > 0) {
    createPayload.HostConfig.CapAdd = capAdd;
  }

  const created = await dockerJson(
    'POST',
    `/containers/create?name=${encodeURIComponent(cleanName)}`,
    15000,
    createPayload
  );

  await dockerRequest('POST', `/containers/${created.Id}/start`, 15000);
  invalidateDockerListCache();

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
  const next = overrideConfig
    ? {
        ...current,
        ...overrideConfig,
        labels: current.labels,
        cmd: current.cmd,
        entrypoint: current.entrypoint,
        capAdd: current.capAdd
      }
    : current;

  // Preserve bind modes when overrideConfig didn't include mode
  if (overrideConfig && Array.isArray(overrideConfig.volumes) && Array.isArray(current.volumes)) {
    next.volumes = overrideConfig.volumes.map((v) => {
      if (v.mode) return v;
      const orig = current.volumes.find(
        (ov) => ov.hostPath === v.hostPath && ov.containerPath === v.containerPath
      );
      return orig?.mode ? { ...v, mode: orig.mode } : v;
    });
  }

  // Pull newest image BEFORE destroying old container so failure doesn't lose running app
  const fullImage = await pullImage(next.image);
  await removeContainer(containerId, true);

  updateCheckCache.delete(current.image);
  updateCheckCache.delete(fullImage);
  saveDockerCache();

  return await createAndStartContainer({
    ...next,
    image: fullImage,
    skipPull: true
  });
}

function parseImageRef(rawImage) {
  const withoutDigest = String(rawImage || '').split('@')[0].trim();
  if (!withoutDigest) return null;

  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  let namePart = withoutDigest;
  let tag = 'latest';
  if (lastColon > lastSlash) {
    namePart = withoutDigest.slice(0, lastColon);
    tag = withoutDigest.slice(lastColon + 1) || 'latest';
  }

  const segments = namePart.split('/');
  let registry = 'registry-1.docker.io';
  let repo = namePart;

  if (segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')) {
    registry = segments[0];
    repo = segments.slice(1).join('/');
  } else if (segments.length === 1) {
    repo = `library/${segments[0]}`;
  }

  return { registry, repo, tag };
}

function parseWwwAuthenticate(headerVal) {
  if (!headerVal) return null;
  const match = headerVal.match(/Bearer\s+(.+)/i);
  if (!match) return null;
  const params = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = regex.exec(match[1])) !== null) {
    params[m[1]] = m[2];
  }
  return params.realm ? params : null;
}

async function fetchRemoteManifestDigest(imageRefStr) {
  const ref = parseImageRef(imageRefStr);
  if (!ref) throw new Error('Ungültige Image-Referenz');

  const accept = [
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.oci.image.index.v1+json'
  ].join(', ');

  const proto = ref.registry.startsWith('localhost') ? 'http' : 'https';
  const manifestUrl = `${proto}://${ref.registry}/v2/${ref.repo}/manifests/${ref.tag}`;

  let token = '';
  if (ref.registry === 'registry-1.docker.io') {
    const tokenRes = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${ref.repo}:pull`)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      token = tokenData.token || tokenData.access_token || '';
    }
  }

  const makeHeaders = (bearer) => ({
    Accept: accept,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
  });

  let res = await fetch(manifestUrl, {
    method: 'HEAD',
    headers: makeHeaders(token),
    signal: AbortSignal.timeout(6000)
  });

  if (res.status === 401) {
    const authParams = parseWwwAuthenticate(res.headers.get('www-authenticate'));
    if (authParams?.realm) {
      const qs = new URLSearchParams();
      if (authParams.service) qs.set('service', authParams.service);
      qs.set('scope', authParams.scope || `repository:${ref.repo}:pull`);
      const tRes = await fetch(`${authParams.realm}?${qs.toString()}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (tRes.ok) {
        const tJson = await tRes.json();
        const nextToken = tJson.token || tJson.access_token || '';
        if (nextToken) {
          res = await fetch(manifestUrl, {
            method: 'HEAD',
            headers: makeHeaders(nextToken),
            signal: AbortSignal.timeout(6000)
          });
        }
      }
    }
  }

  if (!res.ok) {
    throw new Error(`Registry HTTP ${res.status}`);
  }
  const digest = res.headers.get('docker-content-digest');
  if (!digest) throw new Error('Kein Manifest-Digest von Registry erhalten');
  return digest.trim();
}

async function inspectImageRepoDigests(imageName) {
  const info = await dockerJson('GET', `/images/${encodeURIComponent(imageName)}/json`, 3500);
  const digests = Array.isArray(info?.RepoDigests) ? info.RepoDigests : [];
  return digests.map((d) => {
    const atIdx = d.lastIndexOf('@');
    return atIdx >= 0 ? d.slice(atIdx + 1) : d;
  });
}

async function checkContainerUpdates() {
  if (!fs.existsSync(DOCKER_SOCKET)) {
    throw new Error('Docker Socket (/var/run/docker.sock) ist nicht gemountet.');
  }
  loadDockerCache();
  const rawList = await dockerJson('GET', '/containers/json?all=true', 3000);
  const uniqueImages = [...new Set(rawList.map((c) => c.Image).filter(Boolean))];
  const checkedAt = new Date().toISOString();

  await Promise.all(
    uniqueImages.map(async (imageName) => {
      try {
        const [localDigests, remoteDigest] = await Promise.all([
          inspectImageRepoDigests(imageName),
          fetchRemoteManifestDigest(imageName)
        ]);
        const updateAvailable = localDigests.length > 0 && !localDigests.includes(remoteDigest);
        updateCheckCache.set(imageName, {
          checkedAt,
          localDigests,
          remoteDigest,
          updateAvailable,
          error: null
        });
      } catch (err) {
        updateCheckCache.set(imageName, {
          checkedAt,
          localDigests: [],
          remoteDigest: null,
          updateAvailable: false,
          error: err.message
        });
      }
    })
  );

  lastUpdateCheckAt = checkedAt;
  saveDockerCache();

  const results = rawList.map((c) => {
    const name = (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '');
    const status = updateCheckCache.get(c.Image) || { updateAvailable: false, error: null };
    return {
      id: c.Id.slice(0, 12),
      name,
      image: c.Image,
      updateAvailable: Boolean(status.updateAvailable),
      remoteDigest: status.remoteDigest,
      error: status.error || null
    };
  });

  return {
    checkedAt,
    checkedImages: uniqueImages.length,
    updatesAvailable: results.filter((r) => r.updateAvailable).length,
    results
  };
}

async function getDockerDiskUsage() {
  if (!fs.existsSync(DOCKER_SOCKET)) {
    return {
      available: false,
      allowControl: ALLOW_CONTROL,
      imagesTotalSize: 0,
      imagesReclaimableSize: 0,
      unusedImagesCount: 0,
      volumesTotalSize: 0,
      danglingVolumesCount: 0,
      volumesReclaimableSize: 0,
      buildCacheSize: 0,
      totalReclaimableSize: 0
    };
  }
  const df = await dockerJson('GET', '/system/df', 15000);
  const images = Array.isArray(df?.Images) ? df.Images : [];
  const volumes = Array.isArray(df?.Volumes) ? df.Volumes : [];
  const buildCache = Array.isArray(df?.BuildCache) ? df.BuildCache : [];

  const imagesTotalSize = images.reduce((acc, i) => acc + Math.max(0, Number(i.Size) || 0), 0);
  const unusedImages = images.filter((i) => (Number(i.Containers) || 0) === 0);
  const imagesReclaimableSize = unusedImages.reduce((acc, i) => acc + Math.max(0, Number(i.Size) || 0), 0);

  const volumesTotalSize = volumes.reduce((acc, v) => acc + Math.max(0, Number(v.UsageData?.Size) || 0), 0);
  const danglingVolumes = volumes.filter((v) => (Number(v.UsageData?.RefCount) || 0) === 0);
  const volumesReclaimableSize = danglingVolumes.reduce((acc, v) => acc + Math.max(0, Number(v.UsageData?.Size) || 0), 0);

  const buildCacheSize = buildCache.reduce((acc, b) => acc + Math.max(0, Number(b.Size) || 0), 0);

  return {
    available: true,
    allowControl: ALLOW_CONTROL,
    imagesCount: images.length,
    unusedImagesCount: unusedImages.length,
    imagesTotalSize,
    imagesReclaimableSize,
    volumesCount: volumes.length,
    danglingVolumesCount: danglingVolumes.length,
    volumesTotalSize,
    volumesReclaimableSize,
    buildCacheCount: buildCache.length,
    buildCacheSize,
    totalReclaimableSize: imagesReclaimableSize + buildCacheSize + volumesReclaimableSize
  };
}

async function pruneDockerResources({ images = true, buildCache = true, volumes = false } = {}) {
  if (!ALLOW_CONTROL) {
    throw new Error('Container-Steuerung ist deaktiviert (ALLOW_DOCKER_CONTROL=true setzen).');
  }
  let reclaimedBytes = 0;
  let imagesDeleted = 0;
  let volumesDeleted = 0;

  if (images) {
    // Only prune unused images when dangling=false is explicitly requested or prune dangling + unused safely
    const imgRes = await dockerJson('POST', '/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D', 60_000).catch(() => null);
    if (imgRes) {
      reclaimedBytes += Number(imgRes.SpaceReclaimed) || 0;
      imagesDeleted += Array.isArray(imgRes.ImagesDeleted) ? imgRes.ImagesDeleted.length : 0;
    }
  }

  if (buildCache) {
    const bcRes = await dockerJson('POST', '/build/prune', 60_000).catch(() => null);
    if (bcRes) {
      reclaimedBytes += Number(bcRes.SpaceReclaimed) || 0;
    }
  }

  if (volumes) {
    const volRes = await dockerJson('POST', '/volumes/prune', 60_000).catch(() => null);
    if (volRes) {
      reclaimedBytes += Number(volRes.SpaceReclaimed) || 0;
      volumesDeleted += Array.isArray(volRes.VolumesDeleted) ? volRes.VolumesDeleted.length : 0;
    }
  }

  const diskUsage = await getDockerDiskUsage().catch(() => null);
  return {
    ok: true,
    reclaimedBytes,
    imagesDeleted,
    volumesDeleted,
    diskUsage
  };
}

module.exports = {
  dockerRequest,
  dockerJson,
  pullImage,
  collectDockerContainers,
  getContainerLogs,
  controlContainer,
  removeContainer,
  createAndStartContainer,
  inspectContainerConfig,
  recreateOrUpdateContainer,
  checkContainerUpdates,
  getDockerDiskUsage,
  pruneDockerResources
};
