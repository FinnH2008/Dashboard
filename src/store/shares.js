const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getAllowedRoots, assertAllowedPath } = require('../collectors/files');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readSharesRaw() {
  ensureDataDir();
  if (!fs.existsSync(SHARES_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSharesRaw(list) {
  ensureDataDir();
  fs.writeFileSync(SHARES_FILE, JSON.stringify(list, null, 2), { mode: 0o600, encoding: 'utf8' });
}

function isExpired(share) {
  if (!share?.expiresAt) return false;
  return Date.now() > new Date(share.expiresAt).getTime();
}

function toPublicShare(share) {
  return {
    id: share.id,
    token: share.token,
    name: share.name,
    targetPath: share.targetPath,
    isDirectory: Boolean(share.isDirectory),
    sizeBytes: Number(share.sizeBytes) || 0,
    hasPassword: Boolean(share.passwordHash?.salt && share.passwordHash?.hash),
    expiresAt: share.expiresAt || null,
    downloads: Number(share.downloads) || 0,
    createdAt: share.createdAt
  };
}

function pruneExpiredShares(list) {
  const filtered = list.filter((s) => !isExpired(s));
  if (filtered.length !== list.length) {
    writeSharesRaw(filtered);
  }
  return filtered;
}

function listShares() {
  const list = pruneExpiredShares(readSharesRaw());
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return list.map(toPublicShare);
}

function createShare({ targetPath, ttlHours = 168, password = '' }, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const realTarget = assertAllowedPath(targetPath, roots);
  if (!fs.existsSync(realTarget)) {
    const err = new Error('Freigabe-Ziel existiert nicht.');
    err.statusCode = 404;
    throw err;
  }
  const st = fs.statSync(realTarget);
  const token = crypto.randomBytes(12).toString('base64url');
  const id = `sh-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const hours = Number(ttlHours);
  const expiresAt = Number.isFinite(hours) && hours > 0
    ? new Date(Date.now() + Math.min(8760, hours) * 3600 * 1000).toISOString()
    : null;

  let passwordHash = null;
  if (password && String(password).trim()) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    passwordHash = { salt, hash };
  }

  const entry = {
    id,
    token,
    name: path.basename(realTarget) || 'download',
    targetPath: realTarget,
    isDirectory: st.isDirectory(),
    sizeBytes: st.isDirectory() ? 0 : st.size,
    passwordHash,
    expiresAt,
    downloads: 0,
    createdAt: new Date().toISOString()
  };

  const list = pruneExpiredShares(readSharesRaw());
  list.unshift(entry);
  writeSharesRaw(list);
  return toPublicShare(entry);
}

function revokeShare(idOrToken) {
  const key = String(idOrToken || '').trim();
  const list = readSharesRaw();
  const next = list.filter((s) => s.id !== key && s.token !== key);
  if (next.length === list.length) {
    const err = new Error('Freigabe-Link nicht gefunden.');
    err.statusCode = 404;
    throw err;
  }
  writeSharesRaw(next);
  return { ok: true };
}

function getShareByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const list = pruneExpiredShares(readSharesRaw());
  const match = list.find((s) => s.token === token);
  if (!match) return null;
  if (!fs.existsSync(match.targetPath)) return null;
  return match;
}

function verifySharePassword(share, candidate) {
  if (!share?.passwordHash?.salt || !share?.passwordHash?.hash) return true;
  try {
    const derived = crypto.scryptSync(String(candidate || ''), share.passwordHash.salt, 64);
    const expected = Buffer.from(share.passwordHash.hash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function recordShareDownload(token) {
  const list = readSharesRaw();
  const idx = list.findIndex((s) => s.token === token);
  if (idx === -1) return;
  list[idx].downloads = (Number(list[idx].downloads) || 0) + 1;
  writeSharesRaw(list);
}

module.exports = {
  listShares,
  createShare,
  revokeShare,
  getShareByToken,
  verifySharePassword,
  recordShareDownload,
  toPublicShare
};
