const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');

function getSslFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'ssl-targets.json');
}

function ensureDataDir() {
  const dir = path.dirname(getSslFile());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSslTargets() {
  ensureDataDir();
  const file = getSslFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.targets) ? parsed.targets : [];
  } catch {
    return [];
  }
}

function persistSslTargetsRaw(targets) {
  ensureDataDir();
  fs.writeFileSync(
    getSslFile(),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        targets
      },
      null,
      2
    ),
    'utf8'
  );
}

function normalizeHostInput(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\//i, '').split('/')[0].trim();
  return s;
}

function saveSslTargets(list = []) {
  const existingById = new Map(loadSslTargets().map((t) => [t.id, t]));
  const clean = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const host = normalizeHostInput(item.host).slice(0, 140);
    if (!host || !/^[a-zA-Z0-9._:-]+$/.test(host)) continue;
    const portNum = Number(item.port) || 443;
    const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 443;
    const name = String(item.name || host).trim().slice(0, 60) || host;
    const id = String(item.id || `ssl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const prev = existingById.get(id);
    const sameEndpoint = prev && prev.host === host && (prev.port || 443) === port;
    clean.push({
      id,
      name,
      host,
      port,
      valid: sameEndpoint ? prev.valid ?? null : null,
      authorized: sameEndpoint ? prev.authorized ?? null : null,
      issuer: sameEndpoint ? prev.issuer || null : null,
      subject: sameEndpoint ? prev.subject || null : null,
      validFrom: sameEndpoint ? prev.validFrom || null : null,
      validTo: sameEndpoint ? prev.validTo || null : null,
      daysRemaining: sameEndpoint && typeof prev.daysRemaining === 'number' ? prev.daysRemaining : null,
      error: sameEndpoint ? prev.error || null : null,
      checkedAt: sameEndpoint ? prev.checkedAt || null : null
    });
  }
  persistSslTargetsRaw(clean);
  return clean;
}

function probeSslCertificate(host, port = 443, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const checkedAt = new Date().toISOString();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, checkedAt });
    };

    const socket = tls.connect(
      {
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(false);
          const authorized = Boolean(socket.authorized);
          const authError = socket.authorizationError || null;
          socket.end();

          if (!cert || !cert.valid_to) {
            return finish({
              valid: false,
              authorized: false,
              issuer: null,
              subject: null,
              validFrom: null,
              validTo: null,
              daysRemaining: null,
              error: 'Kein Zertifikat erhalten'
            });
          }

          const validToDate = new Date(cert.valid_to);
          const validFromDate = cert.valid_from ? new Date(cert.valid_from) : null;
          const daysRemaining = Number.isNaN(validToDate.getTime())
            ? null
            : Math.floor((validToDate.getTime() - Date.now()) / 86_400_000);
          const notExpired = daysRemaining !== null && daysRemaining >= 0;
          const issuerStr = cert.issuer?.O || cert.issuer?.CN || null;
          const subjectStr = cert.subject?.CN || host;

          return finish({
            valid: notExpired,
            authorized,
            issuer: issuerStr,
            subject: subjectStr,
            validFrom: validFromDate && !Number.isNaN(validFromDate.getTime()) ? validFromDate.toISOString() : null,
            validTo: !Number.isNaN(validToDate.getTime()) ? validToDate.toISOString() : null,
            daysRemaining,
            error: !notExpired ? 'Zertifikat abgelaufen' : !authorized && authError ? String(authError) : null
          });
        } catch (err) {
          socket.destroy();
          return finish({
            valid: false,
            authorized: false,
            issuer: null,
            subject: null,
            validFrom: null,
            validTo: null,
            daysRemaining: null,
            error: err.message
          });
        }
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      finish({
        valid: false,
        authorized: false,
        issuer: null,
        subject: null,
        validFrom: null,
        validTo: null,
        daysRemaining: null,
        error: 'Zeitüberschreitung'
      });
    });

    socket.on('error', (err) => {
      finish({
        valid: false,
        authorized: false,
        issuer: null,
        subject: null,
        validFrom: null,
        validTo: null,
        daysRemaining: null,
        error: err.message || 'TLS-Fehler'
      });
    });
  });
}

async function checkAllSslTargets() {
  const targets = loadSslTargets();
  if (targets.length === 0) return [];
  const checked = await Promise.all(
    targets.map(async (t) => {
      const probe = await probeSslCertificate(t.host, t.port || 443);
      return {
        ...t,
        ...probe
      };
    })
  );
  try {
    persistSslTargetsRaw(checked);
  } catch {
    // ignore fs write error
  }
  return checked;
}

module.exports = {
  loadSslTargets,
  saveSslTargets,
  checkAllSslTargets,
  probeSslCertificate
};
