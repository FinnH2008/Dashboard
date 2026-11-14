const crypto = require('node:crypto');

const COOKIE_NAME = 'hs_session';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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
    result[key] = decodeURIComponent(val);
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
  const [payload, sig] = token.split('.');
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
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
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
  clearSessionCookie
};
