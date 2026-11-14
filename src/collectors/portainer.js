const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const PORTAINER_CACHE_TTL_MS = 15_000;
let portainerCache = { ts: 0, key: '', data: null };

function invalidatePortainerCache() {
  portainerCache = { ts: 0, key: '', data: null };
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

function detectPortainerUrlFromContainers(containers = []) {
  const match = (containers || []).find(
    (c) =>
      c.name?.toLowerCase() === 'portainer' ||
      c.name?.toLowerCase().includes('portainer-ce') ||
      (c.image || '').toLowerCase().includes('portainer/portainer')
  );
  if (!match) return '';
  const ports = match.ports || [];
  const httpsPort = ports.find((p) => p.publicPort === 9443 || p.privatePort === 9443);
  if (httpsPort) return `https://localhost:${httpsPort.publicPort}`;
  const httpPort = ports.find((p) => p.publicPort === 9000 || p.privatePort === 9000 || p.publicPort);
  if (httpPort) return `http://localhost:${httpPort.publicPort}`;
  return '';
}

function portainerRequest(method, baseUrl, apiKey, apiPath, bodyObj = null, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const cleanBase = normalizeUrl(baseUrl);
    if (!cleanBase) return reject(new Error('Keine Portainer-URL konfiguriert.'));

    let target;
    try {
      target = new URL(`${cleanBase}${apiPath}`);
    } catch {
      return reject(new Error('Ungültige Portainer-URL.'));
    }

    const client = target.protocol === 'https:' ? https : http;
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      Accept: 'application/json'
    };
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: timeoutMs,
        // Portainer CE often uses a self-signed cert on :9443 in LAN setups
        rejectUnauthorized: process.env.PORTAINER_TLS_VERIFY === 'true'
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            let msg = text;
            try {
              const parsed = JSON.parse(text);
              msg = parsed.message || parsed.details || text;
            } catch {
              // ignore
            }
            const err = new Error(`Portainer API ${res.statusCode}: ${msg}`);
            err.statusCode = res.statusCode === 401 || res.statusCode === 403 ? 401 : 502;
            return reject(err);
          }
          if (!text) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Portainer API Zeitüberschreitung')));
    req.on('error', (err) => {
      const wrapped = new Error(`Portainer nicht erreichbar: ${err.message}`);
      wrapped.statusCode = 502;
      reject(wrapped);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function resolveEndpoint(baseUrl, apiKey, preferredId = null) {
  const endpoints = await portainerRequest('GET', baseUrl, apiKey, '/api/endpoints');
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error('Keine Portainer-Umgebungen (Endpoints) gefunden.');
  }
  const chosen =
    (preferredId && endpoints.find((e) => Number(e.Id) === Number(preferredId))) ||
    endpoints.find((e) => e.Name === 'local') ||
    endpoints[0];
  return {
    endpointId: chosen.Id,
    endpointName: chosen.Name || `Endpoint ${chosen.Id}`,
    endpoints: endpoints.map((e) => ({ id: e.Id, name: e.Name, status: e.Status }))
  };
}

let portainerRefreshInFlight = false;

async function fetchPortainerStatus(config, containers = []) {
  const detectedUrl = detectPortainerUrlFromContainers(containers);
  const baseUrl = normalizeUrl(config?.portainerUrl) || detectedUrl;
  const apiKey = config?.portainerApiKey || '';

  if (!baseUrl || !apiKey) {
    return {
      configured: Boolean(config?.portainerUrl),
      connected: false,
      url: baseUrl,
      detectedUrl,
      endpointId: config?.portainerEndpointId || 1,
      endpointName: 'local',
      error: !baseUrl
        ? null
        : 'Für Stack-Verwaltung optional Portainer API-Token in den Einstellungen hinterlegen.',
      stacks: []
    };
  }

  const cacheKey = `${baseUrl}|${apiKey.slice(0, 8)}|${config?.portainerEndpointId || ''}`;
  const isFresh = portainerCache.data && portainerCache.key === cacheKey && Date.now() - portainerCache.ts < PORTAINER_CACHE_TTL_MS;
  if (isFresh) {
    return portainerCache.data;
  }

  if (!portainerRefreshInFlight) {
    portainerRefreshInFlight = true;
    (async () => {
      try {
        const { endpointId, endpointName } = await resolveEndpoint(baseUrl, apiKey, config?.portainerEndpointId);
        const rawStacks = await portainerRequest('GET', baseUrl, apiKey, '/api/stacks');
        const stacks = (Array.isArray(rawStacks) ? rawStacks : [])
          .filter((s) => !s.EndpointId || Number(s.EndpointId) === Number(endpointId))
          .map((s) => {
            const matchingContainers = (containers || []).filter((c) => c.stackName === s.Name);
            const runningCount = matchingContainers.filter((c) => c.state === 'running').length;
            const typeLabel = s.Type === 1 ? 'Swarm' : s.Type === 3 ? 'Kubernetes' : 'Compose';
            return {
              id: s.Id,
              name: s.Name,
              type: typeLabel,
              status: s.Status,
              statusLabel: s.Status === 1 ? 'Aktiv' : 'Inaktiv',
              endpointId: s.EndpointId || endpointId,
              containerCount: matchingContainers.length,
              runningCount,
              deepLink: `${baseUrl}/#!/${s.EndpointId || endpointId}/docker/stacks/${encodeURIComponent(s.Name)}?id=${s.Id}&type=${s.Type || 2}&regular=true`
            };
          });

        portainerCache = {
          ts: Date.now(),
          key: cacheKey,
          data: {
            configured: true,
            connected: true,
            url: baseUrl,
            detectedUrl,
            endpointId,
            endpointName,
            error: null,
            stacks
          }
        };
      } catch (err) {
        portainerCache = {
          ts: Date.now(),
          key: cacheKey,
          data: {
            configured: true,
            connected: false,
            url: baseUrl,
            detectedUrl,
            endpointId: config?.portainerEndpointId || 1,
            endpointName: 'local',
            error: err.message,
            stacks: []
          }
        };
      } finally {
        portainerRefreshInFlight = false;
      }
    })();
  }

  if (portainerCache.data && portainerCache.key === cacheKey) {
    return portainerCache.data;
  }

  return {
    configured: true,
    connected: false,
    url: baseUrl,
    detectedUrl,
    endpointId: config?.portainerEndpointId || 1,
    endpointName: 'local',
    error: 'Verbinde mit Portainer…',
    stacks: []
  };
}

async function testPortainerConnection({ url, apiKey, endpointId }) {
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) throw new Error('Bitte Portainer-URL angeben (z. B. https://<server-ip>:9443).');
  if (!apiKey) throw new Error('Bitte Portainer API-Token angeben (Portainer → My account → Access tokens).');

  const ep = await resolveEndpoint(cleanUrl, apiKey, endpointId);
  const rawStacks = await portainerRequest('GET', cleanUrl, apiKey, '/api/stacks');
  return {
    ok: true,
    url: cleanUrl,
    endpointId: ep.endpointId,
    endpointName: ep.endpointName,
    endpoints: ep.endpoints,
    stackCount: Array.isArray(rawStacks) ? rawStacks.length : 0
  };
}

async function deployStackViaPortainer(stackName, yamlContent, config) {
  const cleanName = String(stackName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  if (!cleanName) throw new Error('Ungültiger Stack-Name.');
  if (!yamlContent || !String(yamlContent).trim()) throw new Error('Compose-YAML darf nicht leer sein.');

  const baseUrl = normalizeUrl(config?.portainerUrl);
  const apiKey = config?.portainerApiKey || '';
  if (!baseUrl || !apiKey) {
    throw new Error('Portainer-URL und API-Token erforderlich.');
  }

  const { endpointId } = await resolveEndpoint(baseUrl, apiKey, config?.portainerEndpointId);

  // Check if stack with same name already exists -> update instead of duplicate create
  const existing = await portainerRequest('GET', baseUrl, apiKey, '/api/stacks');
  const match = Array.isArray(existing)
    ? existing.find((s) => s.Name === cleanName && Number(s.EndpointId) === Number(endpointId))
    : null;

  let stack;
  if (match) {
    stack = await portainerRequest(
      'PUT',
      baseUrl,
      apiKey,
      `/api/stacks/${match.Id}?endpointId=${endpointId}`,
      {
        StackFileContent: String(yamlContent),
        PullImage: true,
        Prune: false
      },
      30000
    );
  } else {
    stack = await portainerRequest(
      'POST',
      baseUrl,
      apiKey,
      `/api/stacks/create/standalone/string?endpointId=${endpointId}`,
      {
        Name: cleanName,
        StackFileContent: String(yamlContent),
        FromAppTemplate: false
      },
      30000
    );
  }

  invalidatePortainerCache();
  return {
    ok: true,
    via: 'portainer',
    name: cleanName,
    stackId: stack?.Id || match?.Id || null,
    endpointId
  };
}

async function controlPortainerStack(stackId, action, config) {
  if (!['start', 'stop', 'delete'].includes(action)) {
    throw new Error('Ungültige Stack-Aktion.');
  }

  const baseUrl = normalizeUrl(config?.portainerUrl);
  const apiKey = config?.portainerApiKey || '';
  if (!baseUrl || !apiKey) {
    throw new Error('Portainer-URL und API-Token erforderlich.');
  }

  const { endpointId } = await resolveEndpoint(baseUrl, apiKey, config?.portainerEndpointId);

  if (action === 'start') {
    await portainerRequest('POST', baseUrl, apiKey, `/api/stacks/${encodeURIComponent(stackId)}/start?endpointId=${endpointId}`, {});
  } else if (action === 'stop') {
    await portainerRequest('POST', baseUrl, apiKey, `/api/stacks/${encodeURIComponent(stackId)}/stop?endpointId=${endpointId}`, {});
  } else if (action === 'delete') {
    await portainerRequest('DELETE', baseUrl, apiKey, `/api/stacks/${encodeURIComponent(stackId)}?endpointId=${endpointId}`);
  }

  invalidatePortainerCache();
  return { ok: true, id: stackId, action };
}

module.exports = {
  fetchPortainerStatus,
  testPortainerConnection,
  deployStackViaPortainer,
  controlPortainerStack,
  invalidatePortainerCache
};
