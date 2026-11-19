const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');

const {
  isAuthEnabled,
  isTotpEnabled,
  isAuthenticated,
  verifyPassword,
  verifyTotpForLogin,
  setupTotp,
  enableTotp,
  disableTotp,
  getAuthMeta,
  setDashboardPassword,
  createSessionCookie,
  clearSessionCookie,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  parseCookies,
  signToken,
  verifyToken
} = require('./auth');
const { attachTerminalUpgrade } = require('./terminal');
const { collectSystemMetrics, triggerHostPower, getHostNetworkAddresses } = require('./collectors/system');
const {
  collectStorageMetrics,
  getStorageHistory,
  recordStorageHistory,
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
  recreateOrUpdateContainer,
  pullContainerImage,
  checkContainerUpdates,
  getCachedContainerUpdates,
  getDockerDiskUsage,
  pruneDockerResources,
  loadAutoUpdateConfig,
  saveAutoUpdateConfig,
  runAutoUpdatePass
} = require('./collectors/docker');
const {
  getComposeTemplates,
  listStacks,
  deployStack,
  stopOrRemoveStack,
  getStackYaml,
  saveStackYaml
} = require('./collectors/compose');
const { getSmbStatus, applySmbShares } = require('./collectors/smb');
const {
  listLiveDirectory,
  listDirectoriesOnly,
  streamLiveFile,
  streamVideoTranscode,
  streamThumbnail,
  readImageExif,
  searchLiveFiles,
  cleanupExpiredTrash,
  createLiveFolder,
  renameLiveItem,
  copyOrMoveLiveItems,
  deleteLiveItems,
  listTrash,
  restoreFromTrash,
  deleteTrashItems,
  emptyTrash,
  saveLiveUpload,
  saveLiveUploadStream,
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
  getPortainerStackFile,
  invalidatePortainerCache
} = require('./collectors/portainer');
const { startStorageAnalysis, getAnalysisStatus } = require('./collectors/analyzer');
const {
  getAutomationState,
  saveWatchdogConfig,
  saveSchedules,
  runScheduleNow,
  startWatchdogScheduler,
  stopWatchdogScheduler
} = require('./collectors/watchdog');
const {
  listWolDevices,
  saveWolDevices,
  sendMagicPacket,
  wakeDeviceById
} = require('./collectors/wol');
const {
  getPublicNotificationState,
  saveNotificationConfig,
  sendTestNotification,
  evaluateSystemNotifications
} = require('./collectors/notifications');
const { collectHostAndNetworkStatus, savePingTargets, loadHostCacheSnapshot } = require('./collectors/host');
const { loadSslTargets, saveSslTargets, checkAllSslTargets } = require('./collectors/ssl');
const { loadConfig, getPublicConfig, saveConfig } = require('./store/services');
const { logAuditEvent, listAuditEvents } = require('./store/audit');
const {
  loadTelemetryHistory,
  recordTelemetryPoint,
  flushTelemetryHistorySync,
  getTelemetryHistory,
  getLastSampleAgeMs
} = require('./store/telemetry');
const {
  listShares,
  createShare,
  revokeShare,
  getShareByToken,
  verifySharePassword,
  recordShareDownload
} = require('./store/shares');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const CATALOG_FILE = path.join(process.cwd(), 'config', 'app-catalog.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'self'"
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
    Promise.resolve(collectSystemMetrics(config.serverName, config.power)),
    fetchPortainerStatus(config, docker.containers || [])
  ]);

  const snapshot = {
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
  recordTelemetryPoint(snapshot);
  return snapshot;
}

function escapeShareHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatShareSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1000 && idx < units.length - 1) {
    val /= 1000;
    idx += 1;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}

function isShareCookieValid(req, share) {
  if (!share?.passwordHash?.salt || !share?.passwordHash?.hash) return true;
  const cookies = parseCookies(req);
  const rawToken = cookies[`hs_share_${share.token}`];
  if (!rawToken) return false;
  const decoded = verifyToken(rawToken);
  return Boolean(decoded && decoded.token === share.token);
}

function renderPublicSharePage(share, unlocked, errorMsg = '') {
  const safeName = escapeShareHtml(share.name || 'Download');
  const metaText = share.isDirectory ? 'Ordner (als ZIP-Archiv)' : `Datei · ${formatShareSize(share.sizeBytes)}`;
  const expText = share.expiresAt
    ? `Gültig bis ${escapeShareHtml(new Date(share.expiresAt).toLocaleString('de-DE'))}`
    : 'Unbegrenzt gültig';

  const bodyHtml = unlocked
    ? `
      <p class="meta">${escapeShareHtml(metaText)} · ${expText}</p>
      <a class="btn" href="/s/${encodeURIComponent(share.token)}?download=1">${share.isDirectory ? 'Als ZIP herunterladen' : 'Datei herunterladen'}</a>
    `
    : `
      <p class="meta">Diese Freigabe ist passwortgeschützt · ${expText}</p>
      ${errorMsg ? `<p class="err">${escapeShareHtml(errorMsg)}</p>` : ''}
      <form method="POST" action="/s/${encodeURIComponent(share.token)}">
        <input type="password" name="password" placeholder="Freigabe-Passwort eingeben…" autofocus required />
        <button class="btn" type="submit">Freigabe entsperren</button>
      </form>
    `;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName} · Homeserver Freigabe</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#141518; color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:20px; }
    .card { width:100%; max-width:420px; background:#1b1d21; border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:24px; box-sizing:border-box; display:flex; flex-direction:column; gap:14px; }
    h1 { margin:0; font-size:18px; word-break:break-word; }
    .meta { margin:0; font-size:13px; color:#a1a1aa; }
    .err { margin:0; font-size:13px; color:#ff6961; }
    form { display:flex; flex-direction:column; gap:10px; }
    input { padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.16); background:#111215; color:#fff; font-size:14px; }
    .btn { display:inline-block; text-align:center; padding:10px 16px; border-radius:8px; background:#0a84ff; color:#fff; font-weight:600; font-size:14px; text-decoration:none; border:none; cursor:pointer; }
    .btn:hover { filter:brightness(1.08); }
  </style>
</head>
<body>
  <main class="card">
    <h1>${share.isDirectory ? '📁' : '📄'} ${safeName}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
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
let sseBroadcastTimer = null;
let sseKeepaliveTimer = null;
let sseInFlight = false;
let lastBroadcastPayload = null;
let lastBroadcastAt = 0;

function stopSseBroadcaster() {
  if (sseBroadcastTimer) {
    clearTimeout(sseBroadcastTimer);
    sseBroadcastTimer = null;
  }
  if (sseKeepaliveTimer) {
    clearInterval(sseKeepaliveTimer);
    sseKeepaliveTimer = null;
  }
}

function broadcastSseFrame(frame) {
  for (const clientRes of activeSseResponses) {
    if (clientRes.destroyed || clientRes.writableEnded) {
      activeSseResponses.delete(clientRes);
      continue;
    }
    try {
      clientRes.write(frame);
    } catch {
      activeSseResponses.delete(clientRes);
    }
  }
  if (activeSseResponses.size === 0) {
    stopSseBroadcaster();
  }
}

async function runSseBroadcastTick() {
  if (activeSseResponses.size === 0) {
    stopSseBroadcaster();
    return;
  }
  if (sseInFlight) return;
  sseInFlight = true;
  try {
    const snapshot = await buildSnapshot(false);
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    lastBroadcastPayload = payload;
    lastBroadcastAt = Date.now();
    broadcastSseFrame(payload);
  } catch (err) {
    broadcastSseFrame(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
  } finally {
    sseInFlight = false;
    if (activeSseResponses.size > 0) {
      sseBroadcastTimer = setTimeout(runSseBroadcastTick, 1000);
    }
  }
}

function ensureSseBroadcaster() {
  if (!sseKeepaliveTimer) {
    sseKeepaliveTimer = setInterval(() => {
      broadcastSseFrame(': keepalive\n\n');
    }, 15000);
  }
  if (!sseBroadcastTimer && !sseInFlight) {
    runSseBroadcastTick();
  }
}

function getTrashRetentionDays() {
  try {
    const auto = getAutomationState();
    const sched = (auto?.schedules || []).find((s) => s.type === 'trash-cleanup' && s.enabled !== false);
    const parsed = Number(sched?.target);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.round(parsed);
  } catch {
    // fallback to default 30 days
  }
  return 30;
}

const SPEEDTEST_CHUNK = Buffer.alloc(64 * 1024, 0x5a);

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

    if (req.method === 'GET' && pathname === '/api/client/context') {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const rawRemote = String(fwd || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
      const isTsIp = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^\[?fd7a:115c:a1e0:/i.test(ip);
      const isLanIp = (ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) || ip === '127.0.0.1' || ip === '::1';
      const viaTailscale = isTsIp(rawRemote) || isTsIp(hostHeader) || hostHeader.endsWith('.ts.net');
      const viaLan = !viaTailscale && (isLanIp(rawRemote) || isLanIp(hostHeader) || hostHeader.endsWith('.local') || hostHeader === 'localhost');
      const addrs = getHostNetworkAddresses();
      return sendJson(res, 200, {
        clientIp: rawRemote,
        hostHeader,
        network: viaTailscale ? 'tailscale' : viaLan ? 'lan' : 'remote',
        viaTailscale,
        viaLan,
        lanIp: addrs.lanIp,
        tailscaleIp: addrs.tailscaleIp,
        allServerIps: addrs.allServerIps
      });
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      return sendJson(res, 200, {
        authEnabled: isAuthEnabled(),
        totpEnabled: isTotpEnabled(),
        authenticated: isAuthenticated(req)
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      checkLoginRateLimit(req);
      const body = await readJsonBody(req);
      if (!verifyPassword(body.password)) {
        recordLoginFailure(req);
        logAuditEvent(req, 'auth.fail', 'Fehlgeschlagener Anmeldeversuch (falsches Passwort).', 'warn');
        return sendJson(res, 401, { error: 'Falsches Passwort' });
      }
      if (isTotpEnabled()) {
        if (!verifyTotpForLogin(body.totpCode)) {
          recordLoginFailure(req);
          logAuditEvent(req, 'auth.fail', 'Fehlgeschlagener Anmeldeversuch (ungültiger 2FA-Code).', 'warn');
          return sendJson(res, 401, {
            error: body.totpCode ? 'Ungültiger 2FA-Code' : '2FA-Code erforderlich',
            totpRequired: true
          });
        }
      }
      clearLoginFailures(req);
      logAuditEvent(req, 'auth.login', 'Erfolgreich am Dashboard angemeldet.', 'ok');
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSessionCookie(req) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
    }

    // ==================== PUBLIC SHARE LINKS (/s/:token) ====================
    const shareMatch = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
    if (shareMatch) {
      const token = shareMatch[1];
      const share = getShareByToken(token);
      if (!share) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end('<h1>Freigabe nicht gefunden oder abgelaufen</h1>');
        return;
      }

      if (req.method === 'POST') {
        checkLoginRateLimit(req);
        const raw = (await readRawBody(req, 32 * 1024)).toString('utf8');
        let submittedPw = '';
        if (String(req.headers['content-type'] || '').includes('application/json')) {
          try {
            submittedPw = JSON.parse(raw || '{}').password || '';
          } catch {
            submittedPw = '';
          }
        } else {
          const params = new URLSearchParams(raw);
          submittedPw = params.get('password') || '';
        }

        if (!verifySharePassword(share, submittedPw)) {
          recordLoginFailure(req);
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end(renderPublicSharePage(share, false, 'Falsches Freigabe-Passwort.'));
          return;
        }
        clearLoginFailures(req);
        const unlockToken = signToken({ token: share.token, exp: Date.now() + 24 * 3600 * 1000 });
        const cookieHeader = `hs_share_${share.token}=${encodeURIComponent(unlockToken)}; Path=/s/${share.token}; HttpOnly; SameSite=Lax; Max-Age=86400`;
        res.writeHead(303, {
          Location: `/s/${share.token}`,
          'Set-Cookie': cookieHeader,
          ...SECURITY_HEADERS
        });
        res.end();
        return;
      }

      if (req.method === 'GET') {
        const unlocked = isShareCookieValid(req, share);
        if (url.searchParams.get('download') === '1') {
          if (!unlocked) {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
            res.end(renderPublicSharePage(share, false, 'Bitte zuerst das Freigabe-Passwort eingeben.'));
            return;
          }
          const cfg = loadConfig();
          recordShareDownload(share.token);
          if (share.isDirectory) {
            return await streamZipDownload([share.targetPath], res, cfg.mediaPaths);
          }
          return await streamLiveFile(req, res, share.targetPath, cfg.mediaPaths, { forceDownload: true });
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end(renderPublicSharePage(share, unlocked));
        return;
      }

      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname.startsWith('/api/') && !isAuthenticated(req)) {
      return sendJson(res, 401, { error: 'Nicht angemeldet', authRequired: true });
    }

    // ==================== AUTH MANAGEMENT & SECURITY AUDIT ====================
    if (req.method === 'GET' && pathname === '/api/auth/meta') {
      return sendJson(res, 200, getAuthMeta());
    }

    if (req.method === 'POST' && pathname === '/api/auth/password') {
      const body = await readJsonBody(req);
      const result = setDashboardPassword(body.currentPassword, body.newPassword);
      logAuditEvent(req, 'auth.password', result.message || 'Dashboard-Passwort geändert.', 'ok');
      return sendJson(res, 200, result, { 'Set-Cookie': createSessionCookie(req) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/totp/setup') {
      const result = setupTotp('Homeserver OS', os.hostname() || 'admin');
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/auth/totp/enable') {
      const body = await readJsonBody(req);
      const result = enableTotp(body.code);
      logAuditEvent(req, 'auth.totp.enable', '2FA (Authenticator-App) aktiviert.', 'ok');
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/auth/totp/disable') {
      const body = await readJsonBody(req);
      const result = disableTotp(body.currentPassword);
      logAuditEvent(req, 'auth.totp.disable', '2FA (Authenticator-App) deaktiviert.', 'warn');
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/audit') {
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit')) || 100));
      return sendJson(res, 200, { events: listAuditEvents(limit) });
    }

    // ==================== PUSH NOTIFICATIONS ====================
    if (req.method === 'GET' && pathname === '/api/notifications/state') {
      return sendJson(res, 200, getPublicNotificationState());
    }

    if (req.method === 'POST' && pathname === '/api/notifications/config') {
      const body = await readJsonBody(req);
      const updated = saveNotificationConfig(body);
      logAuditEvent(req, 'notifications.config', `Push-Benachrichtigungen ${updated.enabled ? 'aktiviert' : 'deaktiviert'}.`, 'info');
      return sendJson(res, 200, updated);
    }

    if (req.method === 'POST' && pathname === '/api/notifications/test') {
      const result = await sendTestNotification();
      logAuditEvent(req, 'notifications.test', 'Test-Push-Benachrichtigung ausgelöst.', result.ok ? 'ok' : 'warn');
      return sendJson(res, 200, result);
    }

    // ==================== HOST PROCESSES, PORTS, VPN, SSL & PING ====================
    if (req.method === 'GET' && pathname === '/api/host/cache') {
      return sendJson(res, 200, loadHostCacheSnapshot() || { collectedAt: null, processes: [], ports: [], vpn: { interfaces: [], containers: [] }, security: null, sslTargets: [], pingTargets: [] });
    }

    if (req.method === 'GET' && pathname === '/api/host/status') {
      const docker = await collectDockerContainers();
      const status = await collectHostAndNetworkStatus(docker.containers || []);
      return sendJson(res, 200, status);
    }

    if (req.method === 'POST' && pathname === '/api/host/ping-targets') {
      const body = await readJsonBody(req);
      savePingTargets(body.targets || []);
      const docker = await collectDockerContainers();
      const status = await collectHostAndNetworkStatus(docker.containers || []);
      return sendJson(res, 200, status);
    }

    if (req.method === 'GET' && pathname === '/api/host/ssl-targets') {
      return sendJson(res, 200, { targets: loadSslTargets() });
    }

    if (req.method === 'POST' && pathname === '/api/host/ssl-targets') {
      const body = await readJsonBody(req);
      saveSslTargets(body.targets || []);
      const targets = await checkAllSslTargets();
      return sendJson(res, 200, { targets });
    }

    if (req.method === 'POST' && pathname === '/api/host/ssl-check') {
      const targets = await checkAllSslTargets();
      return sendJson(res, 200, { targets });
    }

    // ==================== TELEMETRY & SNAPSHOT ====================
    if (req.method === 'GET' && pathname === '/api/telemetry/history') {
      const limit = Number(url.searchParams.get('limit')) || 300;
      const rangeSec = Number(url.searchParams.get('rangeSec')) || 0;
      return sendJson(res, 200, getTelemetryHistory(limit, rangeSec));
    }

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

      if (lastBroadcastPayload && Date.now() - lastBroadcastAt < 2500) {
        try {
          res.write(lastBroadcastPayload);
        } catch {
          activeSseResponses.delete(res);
          return;
        }
      }

      const cleanup = () => {
        activeSseResponses.delete(res);
        if (activeSseResponses.size === 0) {
          stopSseBroadcaster();
        }
      };
      req.on('close', cleanup);
      res.on('close', cleanup);

      ensureSseBroadcaster();
      return;
    }

    if (req.method === 'GET' && pathname === '/api/net/ping') {
      return sendJson(res, 200, { ok: true, ts: Date.now() });
    }

    if (req.method === 'GET' && pathname === '/api/net/download') {
      const mb = Math.min(64, Math.max(1, Number(url.searchParams.get('mb')) || 16));
      const totalBytes = Math.round(mb * 1024 * 1024);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(totalBytes),
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS
      });
      let sent = 0;
      let aborted = false;
      req.on('close', () => { aborted = true; });
      const pump = () => {
        while (!aborted && sent < totalBytes) {
          const remaining = totalBytes - sent;
          const slice = remaining >= SPEEDTEST_CHUNK.length
            ? SPEEDTEST_CHUNK
            : SPEEDTEST_CHUNK.subarray(0, remaining);
          sent += slice.length;
          if (!res.write(slice)) {
            res.once('drain', pump);
            return;
          }
        }
        if (!aborted) res.end();
      };
      pump();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/net/upload') {
      const maxBytes = 64 * 1024 * 1024;
      let received = 0;
      const startedAt = Date.now();
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            const err = new Error('Speedtest-Upload-Limit (64 MB) überschritten.');
            err.statusCode = 413;
            req.pause();
            reject(err);
          }
        });
        req.on('end', resolve);
        req.on('error', reject);
      });
      const durationMs = Math.max(1, Date.now() - startedAt);
      return sendJson(res, 200, { ok: true, receivedBytes: received, durationMs });
    }

    if (req.method === 'POST' && pathname === '/api/media/scan') {
      return sendJson(res, 200, await buildSnapshot(true));
    }

    if (req.method === 'POST' && pathname === '/api/system/power') {
      const body = await readJsonBody(req);
      logAuditEvent(req, 'system.power', `Server Power-Aktion: ${body.action}`, 'warn');
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

    // ==================== FILES MANAGER PRO & SHARES ====================
    if (req.method === 'GET' && pathname === '/api/files/list') {
      const targetPath = url.searchParams.get('path') || '/';
      const cfg = loadConfig();
      const listing = await listLiveDirectory(targetPath, cfg.mediaPaths);
      return sendJson(res, 200, listing);
    }

    if (req.method === 'GET' && pathname === '/api/files/dirs') {
      const targetPath = url.searchParams.get('path') || '/';
      const cfg = loadConfig();
      return sendJson(res, 200, await listDirectoriesOnly(targetPath, cfg.mediaPaths));
    }

    if (req.method === 'GET' && pathname === '/api/files/search') {
      const query = url.searchParams.get('q') || '';
      const cfg = loadConfig();
      return sendJson(res, 200, await searchLiveFiles(query, cfg.mediaPaths));
    }

    if (req.method === 'GET' && pathname === '/api/files/thumb') {
      const targetPath = url.searchParams.get('path') || '';
      const cfg = loadConfig();
      return await streamThumbnail(req, res, targetPath, cfg.mediaPaths);
    }

    if (req.method === 'GET' && pathname === '/api/files/exif') {
      const targetPath = url.searchParams.get('path') || '';
      const cfg = loadConfig();
      return sendJson(res, 200, await readImageExif(targetPath, cfg.mediaPaths));
    }

    if (req.method === 'GET' && pathname === '/api/files/video') {
      const targetPath = url.searchParams.get('path') || '';
      const startSec = Number(url.searchParams.get('start')) || 0;
      const cfg = loadConfig();
      return await streamVideoTranscode(req, res, targetPath, startSec, cfg.mediaPaths);
    }

    if (req.method === 'GET' && pathname === '/api/shares') {
      return sendJson(res, 200, { shares: listShares() });
    }

    if (req.method === 'POST' && pathname === '/api/shares') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      const share = createShare(body, cfg.mediaPaths);
      logAuditEvent(req, 'share.create', `Freigabe erstellt für "${share.name}" (${share.hasPassword ? 'mit Passwort' : 'ohne Passwort'}).`, 'info');
      return sendJson(res, 200, share);
    }

    const delShareMatch = pathname.match(/^\/api\/shares\/([^/]+)$/);
    if (req.method === 'DELETE' && delShareMatch) {
      const shareId = safeDecodeParam(delShareMatch[1]);
      const result = revokeShare(shareId);
      logAuditEvent(req, 'share.revoke', `Freigabe ${shareId} widerrufen.`, 'info');
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/files/trash') {
      const cfg = loadConfig();
      return sendJson(res, 200, await listTrash(cfg.mediaPaths, getTrashRetentionDays()));
    }

    if (req.method === 'POST' && pathname === '/api/files/trash/restore') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      const result = await restoreFromTrash(
        body.trashKeys || body.items || body.keys || [],
        cfg.mediaPaths,
        body.conflictMode || 'check'
      );
      if (result && result.conflict) {
        return sendJson(res, 409, result);
      }
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/files/trash/delete') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, await deleteTrashItems(body.trashKeys || body.items || body.keys || [], cfg.mediaPaths));
    }

    if (req.method === 'POST' && pathname === '/api/files/trash/empty') {
      const cfg = loadConfig();
      return sendJson(res, 200, await emptyTrash(cfg.mediaPaths));
    }

    if (req.method === 'GET' && pathname === '/api/files/raw') {
      const targetPath = url.searchParams.get('path') || '';
      const download = url.searchParams.get('download') === '1';
      const inline = url.searchParams.get('inline') === '1';
      const cfg = loadConfig();
      return await streamLiveFile(req, res, targetPath, cfg.mediaPaths, { forceDownload: download, inline });
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
      const result = await deleteLiveItems(targets, cfg.mediaPaths, body.permanent === true);
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
      const cfg = loadConfig();
      return sendJson(res, 200, await saveLiveUploadStream(dir, filename, req, cfg.mediaPaths));
    }

    // ==================== SMART FEATURES (ANALYZER, WATCHDOG, WOL) ====================
    if (req.method === 'GET' && pathname === '/api/analyzer/status') {
      return sendJson(res, 200, getAnalysisStatus());
    }

    if (req.method === 'POST' && pathname === '/api/analyzer/scan') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      return sendJson(res, 200, startStorageAnalysis(body.paths || [], cfg.mediaPaths));
    }

    if (req.method === 'GET' && pathname === '/api/automation/state') {
      return sendJson(res, 200, {
        ...getAutomationState(),
        wolDevices: listWolDevices()
      });
    }

    if (req.method === 'POST' && pathname === '/api/automation/watchdog') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, {
        ...saveWatchdogConfig(body),
        wolDevices: listWolDevices()
      });
    }

    if (req.method === 'POST' && pathname === '/api/automation/schedules') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, {
        ...saveSchedules(body.schedules || []),
        wolDevices: listWolDevices()
      });
    }

    const schedRunMatch = pathname.match(/^\/api\/automation\/schedules\/([^/]+)\/run$/);
    if (req.method === 'POST' && schedRunMatch) {
      const schedId = safeDecodeParam(schedRunMatch[1]);
      const stateAfter = await runScheduleNow(schedId, {
        onMediaScan: () => buildSnapshot(true),
        onStorageAnalysis: () => startStorageAnalysis([], loadConfig().mediaPaths),
        onTrashCleanup: (days) => cleanupExpiredTrash(days, loadConfig().mediaPaths)
      });
      return sendJson(res, 200, { ...stateAfter, wolDevices: listWolDevices() });
    }

    if (req.method === 'POST' && pathname === '/api/wol/devices') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { devices: saveWolDevices(body.devices || []) });
    }

    if (req.method === 'POST' && pathname === '/api/wol/wake') {
      const body = await readJsonBody(req);
      if (body.id) {
        return sendJson(res, 200, await wakeDeviceById(body.id));
      }
      return sendJson(res, 200, await sendMagicPacket({
        mac: body.mac,
        broadcastIp: body.broadcastIp,
        port: body.port,
        name: body.name || ''
      }));
    }

    // ==================== STORAGE ADMIN & SMB ====================
    if (req.method === 'GET' && pathname === '/api/storage/history') {
      const limit = Number(url.searchParams.get('limit')) || 60;
      return sendJson(res, 200, getStorageHistory(limit));
    }

    if (req.method === 'POST' && pathname === '/api/storage/history') {
      const cfg = loadConfig();
      const storage = await collectStorageMetrics(cfg.diskLabels);
      recordStorageHistory(storage, true);
      return sendJson(res, 200, getStorageHistory(60));
    }

    if (req.method === 'POST' && pathname === '/api/storage/mount') {
      const body = await readJsonBody(req);
      const resMount = await mountHostDevice(body.devPath, body.mountPoint, body.persistFstab !== false);
      logAuditEvent(req, 'storage.mount', `Laufwerk ${body.devPath} unter ${body.mountPoint} eingehängt.`, 'info');
      return sendJson(res, 200, resMount);
    }

    if (req.method === 'POST' && pathname === '/api/storage/unmount') {
      const body = await readJsonBody(req);
      const resUnmount = await unmountHostPath(body.mountPoint);
      logAuditEvent(req, 'storage.unmount', `Laufwerk ${body.mountPoint} ausgehängt.`, 'warn');
      return sendJson(res, 200, resUnmount);
    }

    if (req.method === 'POST' && pathname === '/api/storage/format') {
      const body = await readJsonBody(req);
      const resFmt = await formatHostDevice(body.devPath, body.fsType, body.label);
      logAuditEvent(req, 'storage.format', `Laufwerk ${body.devPath} als ${body.fsType || 'ext4'} formatiert.`, 'warn');
      return sendJson(res, 200, resFmt);
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

    const portainerStackYamlMatch = pathname.match(/^\/api\/portainer\/stacks\/([^/]+)\/yaml$/);
    if (req.method === 'GET' && portainerStackYamlMatch) {
      const stackId = safeDecodeParam(portainerStackYamlMatch[1]);
      const cfg = loadConfig();
      return sendJson(res, 200, await getPortainerStackFile(stackId, cfg));
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

    const composeYamlMatch = pathname.match(/^\/api\/compose\/([^/]+)\/yaml$/);
    if (req.method === 'GET' && composeYamlMatch) {
      const stackName = safeDecodeParam(composeYamlMatch[1]);
      return sendJson(res, 200, await getStackYaml(stackName));
    }

    if (req.method === 'POST' && pathname === '/api/compose/save') {
      const body = await readJsonBody(req);
      const cfg = loadConfig();
      if (body.target === 'portainer' && cfg.portainerUrl && cfg.portainerApiKey) {
        const resPortainer = await deployStackViaPortainer(body.name, body.yaml, cfg);
        logAuditEvent(req, 'compose.save', `Portainer Stack "${body.name}" aktualisiert.`, 'info');
        return sendJson(res, 200, resPortainer);
      }
      const resLocal = await saveStackYaml(body.name, body.yaml, body.redeploy !== false);
      logAuditEvent(req, 'compose.save', `Compose Stack "${body.name}" gespeichert.`, 'info');
      return sendJson(res, 200, resLocal);
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

    // ==================== DOCKER MAINTENANCE & CONTAINER ACTIONS ====================
    if (req.method === 'GET' && pathname === '/api/docker/autoupdate') {
      return sendJson(res, 200, loadAutoUpdateConfig());
    }

    if (req.method === 'POST' && pathname === '/api/docker/autoupdate') {
      const body = await readJsonBody(req);
      const saved = saveAutoUpdateConfig(body);
      logAuditEvent(req, 'docker.autoupdate.config', `Auto-Update Zeitplan ${saved.enabled ? 'aktiviert' : 'deaktiviert'} (${saved.timeHHMM}).`, 'info');
      return sendJson(res, 200, saved);
    }

    if (req.method === 'POST' && pathname === '/api/docker/autoupdate/run') {
      const result = await runAutoUpdatePass({ forceAllAuto: false });
      logAuditEvent(req, 'docker.autoupdate.run', `Auto-Update Lauf: ${result.updated?.length || 0} aktualisiert, ${result.notified?.length || 0} Updates gefunden.`, 'info');
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/docker/updates') {
      return sendJson(res, 200, await getCachedContainerUpdates());
    }

    if (req.method === 'POST' && pathname === '/api/docker/check-updates') {
      const result = await checkContainerUpdates();
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/docker/disk-usage') {
      return sendJson(res, 200, await getDockerDiskUsage());
    }

    if (req.method === 'POST' && pathname === '/api/docker/prune') {
      const body = await readJsonBody(req);
      const result = await pruneDockerResources({
        images: body.images !== false,
        buildCache: body.buildCache !== false,
        volumes: body.volumes === true
      });
      logAuditEvent(
        req,
        'docker.prune',
        `Docker Bereinigung: ${Math.round((result.reclaimedBytes || 0) / (1024 * 1024))} MB freigegeben (${result.imagesDeleted} Images, ${result.volumesDeleted} Volumes).`,
        'ok'
      );
      return sendJson(res, 200, result);
    }

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
      logAuditEvent(req, `docker.${updateMatch[2]}`, `Container "${result.name}" (${result.image}) neu erstellt/aktualisiert.`, 'info');
      return sendJson(res, 200, result);
    }

    const logsMatch = pathname.match(/^\/api\/docker\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
      const containerId = safeDecodeParam(logsMatch[1]);
      const tail = Math.min(500, Math.max(20, Number(url.searchParams.get('tail')) || 120));
      const logs = await getContainerLogs(containerId, tail);
      return sendJson(res, 200, { id: containerId, logs });
    }

    const actionMatch = pathname.match(/^\/api\/docker\/([^/]+)\/(start|stop|restart|remove|pull)$/);
    if (req.method === 'POST' && actionMatch) {
      const containerId = safeDecodeParam(actionMatch[1]);
      const action = actionMatch[2];

      if (action === 'pull') {
        const result = await pullContainerImage(containerId);
        logAuditEvent(req, 'docker.pull', `Neuestes Image für "${result.name}" (${result.image}) gezogen.`, 'info');
        return sendJson(res, 200, result);
      }

      if (action === 'remove') {
        const result = await removeContainer(containerId, true);
        logAuditEvent(req, 'docker.remove', `Container ${containerId} gelöscht.`, 'warn');
        return sendJson(res, 200, result);
      }

      const result = await controlContainer(containerId, action);
      logAuditEvent(req, `docker.${action}`, `Container ${containerId}: Aktion "${action}" ausgeführt.`, 'info');
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

let idleTelemetryTimer = null;

function gracefulShutdown(signal) {
  console.log(`[Dashboard] ${signal} empfangen – beende Verbindungen sauber…`);
  if (idleTelemetryTimer) {
    clearInterval(idleTelemetryTimer);
    idleTelemetryTimer = null;
  }
  stopSseBroadcaster();
  stopWatchdogScheduler();
  flushTelemetryHistorySync();
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
  loadTelemetryHistory();
  idleTelemetryTimer = setInterval(async () => {
    try {
      if (getLastSampleAgeMs() >= 9000) {
        await buildSnapshot(false);
      }
    } catch {
      // ignore background tick errors
    }
  }, 10_000);
  idleTelemetryTimer.unref();

  startWatchdogScheduler({
    onMediaScan: () => buildSnapshot(true),
    onStorageAnalysis: () => startStorageAnalysis([], loadConfig().mediaPaths),
    onTrashCleanup: (days) => cleanupExpiredTrash(days, loadConfig().mediaPaths)
  });
  console.log(`Homeserver Dashboard läuft auf http://${HOST}:${PORT}`);
});
