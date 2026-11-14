const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = 'hs_session';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');

function loadOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

function getClientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
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

function getConfiguredPassword() {
  return (process.env.DASHBOARD_PASSWORD || '').trim();
}

function isAuthEnabled() {
  return getConfiguredPassword().length > 0;
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
  const configured = getConfiguredPassword();
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

function createSessionCookie() {
  const token = signToken({
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  isAuthEnabled,
  isAuthenticated,
  verifyPassword,
  createSessionCookie,
  clearSessionCookie,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures
};
