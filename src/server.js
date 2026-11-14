const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');

const {
  isAuthEnabled,
  isAuthenticated,
  verifyPassword,
  createSessionCookie,
  clearSessionCookie,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures
} = require('./auth');
const { attachTerminalUpgrade } = require('./terminal');
const { collectSystemMetrics, triggerHostPower } = require('./collectors/system');
const {
  collectStorageMetrics,
  mountHostDevice,
  unmountHostPath,
  formatHostDevice
} = require('./collectors/storage');
const { collectMediaStats } = require('./collectors/media');
const {
  collectDockerContainers,
  getContainerLogs,
  controlContainer,
  removeContainer,
  createAndStartContainer,
  inspectContainerConfig,
  recreateOrUpdateContainer
} = require('./collectors/docker');
const {
  getComposeTemplates,
  listStacks,
  deployStack,
  stopOrRemoveStack
} = require('./collectors/compose');
const { getSmbStatus, applySmbShares } = require('./collectors/smb');
const {
  listLiveDirectory,
  streamLiveFile,
  createLiveFolder,
  renameLiveItem,
  copyOrMoveLiveItems,
  deleteLiveItems,
  saveLiveUpload,
  readLiveTextFile,
  writeLiveTextFile,
  streamZipDownload,
  extractLiveArchive
} = require('./collectors/files');
const {
  fetchPortainerStatus,
  testPortainerConnection,
  deployStackViaPortainer,
  controlPortainerStack,
  invalidatePortainerCache
} = require('./collectors/portainer');
const { loadConfig, getPublicConfig, saveConfig } = require('./store/services');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const CATALOG_FILE = path.join(process.cwd(), 'config', 'app-catalog.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function loadAppCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin'
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}

function readRawBody(req, maxBytes = 1024 * 1024 * 250) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const err = new Error('Datei oder Anfrage überschreitet das Limit (250 MB).');
        err.statusCode = 413;
        reject(err);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024 * 2) {
  const buf = await readRawBody(req, maxBytes);
  const text = buf.toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const err = new Error('Ungültiges JSON-Format');
    err.statusCode = 400;
    throw err;
  }
}

async function buildSnapshot(forceMediaScan = false) {
  const config = loadConfig();
  const publicConfig = getPublicConfig();

  const [storage, media, docker] = await Promise.all([
    collectStorageMetrics(config.diskLabels),
    collectMediaStats(config.mediaPaths, forceMediaScan),
    collectDockerContainers()
  ]);

  const [system, portainer] = await Promise.all([
    Promise.resolve(collectSystemMetrics(config.serverName)),
    fetchPortainerStatus(config, docker.containers || [])
  ]);

  return {
    mode: 'live',
    authEnabled: isAuthEnabled(),
    system,
    storage,
    media,
    docker,
    portainer,
    config: publicConfig,
    meta: {
      generatedAt: new Date().toISOString()
    }
  };
}

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const err = new Error('Ungültige URL-Kodierung');
    err.statusCode = 400;
    throw err;
  }
}

function serveStatic(reqPath, res, method = 'GET') {
  let cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  cleanPath = path.posix.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(PUBLIC_DIR, cleanPath);

  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const isCodeAsset = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': isCodeAsset ? 'no-cache, must-revalidate' : 'public, max-age=3600',
      ...SECURITY_HEADERS
    });
    res.end(method === 'HEAD' ? undefined : content);
  });
}

try {
  collectSystemMetrics();
  setTimeout(() => {
    try {
      collectSystemMetrics();
    } catch {
      // ignore warmup errors
    }
  }, 150);
} catch {
  // ignore initial warmup errors
}

const activeSseResponses = new Set();

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'Ungültige Anfrage-URL' });
  }
  const pathname = url.pathname;

  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', mode: 'live', uptime: process.uptime() });
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      return sendJson(res, 200, {
        authEnabled: isAuthEnabled(),
        authenticated: isAuthenticated(req)
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      checkLoginRateLimit(req);
      const body = await readJsonBody(req);
      if (!verifyPassword(body.password)) {
        recordLoginFailure(req);
        return sendJson(res, 401, { error: 'Falsches Passwort' });
      }
      clearLoginFailures(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSessionCookie() });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }

    if (pathname.startsWith('/api/') && !isAuthenticated(req)) {
      return sendJson(res, 401, { error: 'Nicht angemeldet', authRequired: true });
    }

    // ==================== TELEMETRY & SNAPSHOT ====================
    if (req.method === 'GET' && pathname === '/api/snapshot') {
      const snapshot = await buildSnapshot(false);
      return sendJson(res, 200, snapshot);
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      req.setTimeout(0);
      res.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS
      });
      res.write(': stream-open\n\n');
      activeSseResponses.add(res);

      let closed = false;
      let tickTimer = null;
      let keepaliveTimer = null;
      const STREAM_INTERVAL_MS = 1000;

      const scheduleNext = () => {
        if (closed) return;
        tickTimer = setTimeout(runTick, STREAM_INTERVAL_MS);
      };

      const runTick = async () => {
        if (closed) return;
        try {
          const snapshot = await buildSnapshot(false);
          if (!closed) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch (err) {
          if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        } finally {
          scheduleNext();
        }
      };

      keepaliveTimer = setInterval(() => {
        if (!closed) res.write(': keepalive\n\n');
      }, 15000);

      req.on('close', () => {
        closed = true;
        if (tickTimer) clearTimeout(tickTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
      });

      await runTick();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/media/scan') {
      return sendJson(res, 200, await buildSnapshot(true));
    }

    if (req.method === 'POST' && pathname === '/api/system/power') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, triggerHostPower(body.action));
    }

    // ==================== CONFIG ====================
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, getPublicConfig());
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJsonBody(req);
      const updated = saveConfig(body);
      invalidatePortainerCache();
      return sendJson(res, 200, updated);
    }

    // ==================== FILES MANAGER ====================
    if (req.method === 'GET' && pathname === '/api/files/list') {
      const targetPath = url.searchParams.get('path') || '/';
      const cfg = loadConfig();
      const listing = await listLiveDirectory(targetPath, cfg.mediaPaths);
      return sendJson(res, 200, listing);
    }

    if (req.method === 'GET' && pathname === '/api/files/raw') {
      const targetPath = url.searchParams.get('path') || '';
      const download = url.searchParams.get('download') === '1';
      const cfg = loadConfig();
      return await streamLiveFile(req, res, targetPath, cfg.mediaPaths, download);
    }

    if (req.method === 'GET' && pathname === '/api/files/text') {
      const targetPath = url.searchParams.get('path') || '';
      const cfg = loadConfig();
      return sendJson(res, 200, await readLiveTextFile(targetPath, cfg.mediaPaths));
    }

    if (req.method === 'POST' && pathname === '/api/files/text') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, await writeLiveTextFile(body.path, body.content, cfg.mediaPaths));
    }

    if (req.method === 'POST' && pathname === '/api/files/mkdir') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      const result = await createLiveFolder(body.parentPath, body.name, cfg.mediaPaths);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/files/rename') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, await renameLiveItem(body.path, body.newName, cfg.mediaPaths));
    }

    if (req.method === 'POST' && (pathname === '/api/files/copy' || pathname === '/api/files/move')) {
      const body = await readJsonBody(req);
      const move = pathname === '/api/files/move';
      const cfg = loadConfig();
      return sendJson(res, 200, await copyOrMoveLiveItems(body.sources || [], body.destDir, move, cfg.mediaPaths));
    }

    if (req.method === 'POST' && pathname === '/api/files/delete') {
      const body = await readJsonBody(req);
      const targets = body.paths || (body.path ? [body.path] : []);
      const cfg = loadConfig();
      const result = await deleteLiveItems(targets, cfg.mediaPaths);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/files/zip') {
      const paths = url.searchParams.getAll('path');
      const cfg = loadConfig();
      return await streamZipDownload(paths, res, cfg.mediaPaths);
    }

    if (req.method === 'POST' && pathname === '/api/files/extract') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, await extractLiveArchive(body.path, cfg.mediaPaths));
    }

    if (req.method === 'POST' && pathname === '/api/files/upload') {
      const dir = url.searchParams.get('dir') || '';
      const filename = url.searchParams.get('name') || 'upload.bin';
      const buffer = await readRawBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, await saveLiveUpload(dir, filename, buffer, cfg.mediaPaths));
    }

    // ==================== STORAGE ADMIN & SMB ====================
    if (req.method === 'POST' && pathname === '/api/storage/mount') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await mountHostDevice(body.devPath, body.mountPoint, body.persistFstab !== false));
    }

    if (req.method === 'POST' && pathname === '/api/storage/unmount') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await unmountHostPath(body.mountPoint));
    }

    if (req.method === 'POST' && pathname === '/api/storage/format') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await formatHostDevice(body.devPath, body.fsType, body.label));
    }

    if (req.method === 'GET' && pathname === '/api/smb/status') {
      return sendJson(res, 200, await getSmbStatus());
    }

    if (req.method === 'POST' && pathname === '/api/smb/apply') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await applySmbShares(body));
    }

    // ==================== PORTAINER BRIDGE & COMPOSE STACKS ====================
    if (req.method === 'POST' && pathname === '/api/portainer/test') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      const result = await testPortainerConnection({
        url: body.url || cfg.portainerUrl,
        apiKey: body.apiKey || cfg.portainerApiKey,
        endpointId: body.endpointId || cfg.portainerEndpointId
      });
      return sendJson(res, 200, result);
    }

    const portainerStackMatch = pathname.match(/^\/api\/portainer\/stacks\/([^/]+)\/(start|stop|delete)$/);
    if (req.method === 'POST' && portainerStackMatch) {
      const stackId = safeDecodeParam(portainerStackMatch[1]);
      const action = portainerStackMatch[2];
      const cfg = loadConfig();
      return sendJson(res, 200, await controlPortainerStack(stackId, action, cfg));
    }

    if (req.method === 'GET' && pathname === '/api/appstore/catalog') {
      return sendJson(res, 200, { apps: loadAppCatalog(), templates: getComposeTemplates() });
    }

    if (req.method === 'GET' && pathname === '/api/compose/stacks') {
      return sendJson(res, 200, { stacks: await listStacks() });
    }

    if (req.method === 'POST' && pathname === '/api/compose/deploy') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      if (body.target !== 'local' && ((cfg.portainerUrl && cfg.portainerApiKey) || body.target === 'portainer')) {
        return sendJson(res, 200, await deployStackViaPortainer(body.name, body.yaml, cfg));
      }
      return sendJson(res, 200, await deployStack(body.name, body.yaml));
    }

    const composeActionMatch = pathname.match(/^\/api\/compose\/([^/]+)\/(up|down|pull|delete)$/);
    if (req.method === 'POST' && composeActionMatch) {
      const stackName = safeDecodeParam(composeActionMatch[1]);
      const action = composeActionMatch[2];
      return sendJson(res, 200, await stopOrRemoveStack(stackName, action));
    }

    if (req.method === 'POST' && pathname === '/api/appstore/install') {
      const body = await readJsonBody(req);
      const result = await createAndStartContainer(body);

      const firstPort = body.hostPort || body.ports?.[0]?.hostPort;
      if (body.addBookmark !== false && firstPort) {
        const cfg = loadConfig();
        const existing = cfg.services || [];
        const svcId = `app-${String(body.name || result.name).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
        if (!existing.some((s) => s.id === svcId)) {
          existing.push({
            id: svcId,
            name: body.displayName || body.name,
            category: body.category || 'Docker App',
            url: `http://localhost:${firstPort}`,
            containerMatch: body.name,
            description: body.tagline || `Installiert (${body.image})`
          });
          saveConfig({ services: existing });
        }
      }

      return sendJson(res, 200, result);
    }

    // ==================== DOCKER CONTAINER ACTIONS ====================
    const inspectMatch = pathname.match(/^\/api\/docker\/([^/]+)\/inspect$/);
    if (req.method === 'GET' && inspectMatch) {
      const containerId = safeDecodeParam(inspectMatch[1]);
      const info = await inspectContainerConfig(containerId);
      return sendJson(res, 200, info);
    }

    const updateMatch = pathname.match(/^\/api\/docker\/([^/]+)\/(update|recreate)$/);
    if (req.method === 'POST' && updateMatch) {
      const containerId = safeDecodeParam(updateMatch[1]);
      const body = await readJsonBody(req);
      const override = updateMatch[2] === 'recreate' ? body : null;
      const result = await recreateOrUpdateContainer(containerId, override);
      return sendJson(res, 200, result);
    }

    const logsMatch = pathname.match(/^\/api\/docker\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
      const containerId = safeDecodeParam(logsMatch[1]);
      const tail = Math.min(500, Math.max(20, Number(url.searchParams.get('tail')) || 120));
      const logs = await getContainerLogs(containerId, tail);
      return sendJson(res, 200, { id: containerId, logs });
    }

    const actionMatch = pathname.match(/^\/api\/docker\/([^/]+)\/(start|stop|restart|remove)$/);
    if (req.method === 'POST' && actionMatch) {
      const containerId = safeDecodeParam(actionMatch[1]);
      const action = actionMatch[2];

      if (action === 'remove') {
        const result = await removeContainer(containerId, true);
        return sendJson(res, 200, result);
      }

      const result = await controlContainer(containerId, action);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(pathname, res, req.method);
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.message || 'Internal Server Error' });
  }
});

attachTerminalUpgrade(server);

process.on('unhandledRejection', (reason) => {
  console.error('[Dashboard] Unhandled Rejection:', reason);
});

function gracefulShutdown(signal) {
  console.log(`[Dashboard] ${signal} empfangen – beende Verbindungen sauber…`);
  for (const res of activeSseResponses) {
    try {
      res.end();
    } catch {
      // ignore already closed streams
    }
  }
  activeSseResponses.clear();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`Homeserver Dashboard läuft auf http://${HOST}:${PORT}`);
});
