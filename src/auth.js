const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = 'hs_session';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    ensureDataDir();
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SECRET = loadOrCreateSecret();

const loginAttempts = new Map();
const MAX_ATTEMPTS_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;

function isTrustedProxyAddress(addr) {
  if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') return true;
  const ip = String(addr || '').replace(/^::ffff:/, '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

function getClientKey(req) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (isTrustedProxyAddress(remote)) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return remote;
}

function checkLoginRateLimit(req) {
  const key = getClientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) return;
  if (entry.count >= MAX_ATTEMPTS_PER_WINDOW) {
    const waitSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const err = new Error(`Zu viele Anmeldeversuche. Bitte ${waitSec}s warten.`);
    err.statusCode = 429;
    throw err;
  }
}

function recordLoginFailure(req) {
  const key = getClientKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + MAX_ATTEMPTS_WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (loginAttempts.size > 500) {
    for (const [k, v] of loginAttempts.entries()) {
      if (now > v.resetAt) loginAttempts.delete(k);
    }
  }
}

function clearLoginFailures(req) {
  loginAttempts.delete(getClientKey(req));
}

function getEnvPassword() {
  return (process.env.DASHBOARD_PASSWORD || '').trim();
}

function readAuthFile() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeAuthFile(obj) {
  ensureDataDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(obj, null, 2), { mode: 0o600, encoding: 'utf8' });
}

function isAuthEnabled() {
  const fileCfg = readAuthFile();
  if (fileCfg?.passwordHash?.salt && fileCfg?.passwordHash?.hash) {
    return true;
  }
  if (fileCfg?.disabled === true && !getEnvPassword()) {
    return false;
  }
  return getEnvPassword().length > 0;
}

function getAuthMeta() {
  const fileCfg = readAuthFile();
  const totpEnabled = Boolean(fileCfg?.totp?.enabled && fileCfg?.totp?.secret);
  const totpActivatedAt = totpEnabled ? fileCfg.totp.activatedAt || null : null;
  const backupCodesRemaining = totpEnabled && Array.isArray(fileCfg.totp.backupHashes)
    ? fileCfg.totp.backupHashes.length
    : 0;

  if (fileCfg?.passwordHash?.salt && fileCfg?.passwordHash?.hash) {
    return {
      authEnabled: true,
      mode: 'ui',
      envOverrideActive: Boolean(getEnvPassword()),
      updatedAt: fileCfg.updatedAt || null,
      totpEnabled,
      totpActivatedAt,
      backupCodesRemaining
    };
  }
  if (getEnvPassword()) {
    return {
      authEnabled: true,
      mode: 'env',
      envOverrideActive: true,
      updatedAt: null,
      totpEnabled,
      totpActivatedAt,
      backupCodesRemaining
    };
  }
  return {
    authEnabled: false,
    mode: 'none',
    envOverrideActive: false,
    updatedAt: fileCfg?.updatedAt || null,
    totpEnabled: false,
    totpActivatedAt: null,
    backupCodesRemaining: 0
  };
}

// ==================== TOTP (RFC 6238) 2FA ====================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i += 1) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpCode(secretBase32, counter = Math.floor(Date.now() / 1000 / 30)) {
  const key = decodeBase32(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function findMatchingTotpStep(secretBase32, candidate, windowSteps = 1) {
  const code = String(candidate || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(Date.now() / 1000 / 30);
  const candBuf = Buffer.from(code, 'utf8');
  for (let delta = -windowSteps; delta <= windowSteps; delta += 1) {
    const candidateStep = step + delta;
    const expected = generateTotpCode(secretBase32, candidateStep);
    const expBuf = Buffer.from(expected, 'utf8');
    if (candBuf.length === expBuf.length && crypto.timingSafeEqual(candBuf, expBuf)) {
      return candidateStep;
    }
  }
  return null;
}

function verifyTotpCode(secretBase32, candidate, windowSteps = 1) {
  return findMatchingTotpStep(secretBase32, candidate, windowSteps) !== null;
}

function setupTotp(issuer = 'Homeserver OS', account = 'admin') {
  if (!isAuthEnabled()) {
    const err = new Error('Bitte zuerst ein Dashboard-Passwort festlegen, bevor 2FA aktiviert wird.');
    err.statusCode = 400;
    throw err;
  }
  const secret = encodeBase32(crypto.randomBytes(20));
  const fileCfg = readAuthFile() || {};
  writeAuthFile({
    ...fileCfg,
    pendingTotpSecret: secret,
    pendingTotpCreatedAt: new Date().toISOString()
  });
  const label = encodeURIComponent(`${issuer}:${account}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUrl };
}

function enableTotp(code) {
  const fileCfg = readAuthFile();
  const pendingSecret = fileCfg?.pendingTotpSecret;
  if (!pendingSecret) {
    const err = new Error('Kein 2FA-Setup aktiv. Bitte zuerst QR-Code generieren.');
    err.statusCode = 400;
    throw err;
  }
  if (!verifyTotpCode(pendingSecret, code)) {
    const err = new Error('Der eingegebene 6-stellige Code ist ungültig.');
    err.statusCode = 400;
    throw err;
  }
  const backupCodes = [];
  const backupHashes = [];
  for (let i = 0; i < 8; i += 1) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    backupCodes.push(formatted);
    backupHashes.push(hashPasswordScrypt(formatted));
  }
  const nextCfg = { ...fileCfg };
  delete nextCfg.pendingTotpSecret;
  delete nextCfg.pendingTotpCreatedAt;
  nextCfg.totp = {
    enabled: true,
    secret: pendingSecret,
    activatedAt: new Date().toISOString(),
    backupHashes
  };
  writeAuthFile(nextCfg);
  return { ok: true, backupCodes, ...getAuthMeta() };
}

function disableTotp(currentPassword) {
  if (isAuthEnabled() && !verifyPassword(currentPassword)) {
    const err = new Error('Aktuelles Passwort ist falsch.');
    err.statusCode = 401;
    throw err;
  }
  const fileCfg = readAuthFile() || {};
  const nextCfg = { ...fileCfg };
  delete nextCfg.totp;
  delete nextCfg.pendingTotpSecret;
  delete nextCfg.pendingTotpCreatedAt;
  writeAuthFile(nextCfg);
  return { ok: true, ...getAuthMeta() };
}

function verifyTotpForLogin(candidate) {
  const fileCfg = readAuthFile();
  if (!fileCfg?.totp?.enabled || !fileCfg?.totp?.secret) return true;
  const raw = String(candidate || '').trim().toUpperCase();
  if (!raw) return false;
  const matchedStep = findMatchingTotpStep(fileCfg.totp.secret, raw);
  if (matchedStep !== null) {
    if (typeof fileCfg.totp.lastAcceptedStep === 'number' && matchedStep <= fileCfg.totp.lastAcceptedStep) {
      return false;
    }
    fileCfg.totp.lastAcceptedStep = matchedStep;
    writeAuthFile(fileCfg);
    return true;
  }

  const hashes = Array.isArray(fileCfg.totp.backupHashes) ? fileCfg.totp.backupHashes : [];
  for (let i = 0; i < hashes.length; i += 1) {
    if (verifyScryptHash(raw, hashes[i])) {
      hashes.splice(i, 1);
      fileCfg.totp.backupHashes = hashes;
      writeAuthFile(fileCfg);
      return true;
    }
  }
  return false;
}

function isTotpEnabled() {
  const fileCfg = readAuthFile();
  return isAuthEnabled() && Boolean(fileCfg?.totp?.enabled && fileCfg?.totp?.secret);
}

function hashPasswordScrypt(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plainPassword), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyScryptHash(candidate, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  try {
    const derived = crypto.scryptSync(String(candidate || ''), stored.salt, 64);
    const expected = Buffer.from(stored.hash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function setDashboardPassword(currentPassword, newPassword) {
  if (isAuthEnabled() && !verifyPassword(currentPassword)) {
    const err = new Error('Aktuelles Passwort ist falsch.');
    err.statusCode = 401;
    throw err;
  }

  const fileCfg = readAuthFile() || {};
  const next = String(newPassword ?? '');
  if (!next.trim()) {
    if (getEnvPassword()) {
      // Remove UI override so env DASHBOARD_PASSWORD acts as fallback again
      if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
      return { ok: true, ...getAuthMeta(), message: 'UI-Passwort entfernt — DASHBOARD_PASSWORD aus Umgebungsvariable aktiv.' };
    }
    writeAuthFile({ disabled: true, updatedAt: new Date().toISOString() });
    return { ok: true, ...getAuthMeta(), message: 'Passwortschutz deaktiviert.' };
  }

  if (next.length < 4) {
    const err = new Error('Neues Passwort muss mindestens 4 Zeichen lang sein.');
    err.statusCode = 400;
    throw err;
  }

  const nextCfg = {
    ...fileCfg,
    passwordHash: hashPasswordScrypt(next),
    updatedAt: new Date().toISOString()
  };
  delete nextCfg.disabled;
  writeAuthFile(nextCfg);

  return { ok: true, ...getAuthMeta(), message: 'Dashboard-Passwort erfolgreich gespeichert.' };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function signToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.exp && Date.now() > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

function verifyPassword(candidate) {
  const fileCfg = readAuthFile();
  if (fileCfg?.passwordHash?.salt && fileCfg?.passwordHash?.hash) {
    return verifyScryptHash(candidate, fileCfg.passwordHash);
  }
  const configured = getEnvPassword();
  if (!configured) return true;
  // Compare SHA-256 digests so timingSafeEqual works cleanly regardless of length
  const a = crypto.createHash('sha256').update(String(candidate || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(configured, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  if (!isAuthEnabled()) return true;
  const cookies = parseCookies(req);
  return Boolean(verifyToken(cookies[COOKIE_NAME]));
}

function isSecureRequest(req) {
  if (!req) return false;
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function createSessionCookie(req) {
  const token = signToken({
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}

function clearSessionCookie(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

module.exports = {
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
};
