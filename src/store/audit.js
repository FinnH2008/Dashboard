const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_AUDIT_ENTRIES = 200;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getClientIp(req) {
  if (!req) return 'system';
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const addr = fwd || req.socket?.remoteAddress || 'localhost';
  return addr.replace(/^::ffff:/, '');
}

function readAuditFile() {
  ensureDataDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, MAX_AUDIT_ENTRIES) : [];
  } catch {
    return [];
  }
}

function logAuditEvent(req, action, detail, level = 'info') {
  try {
    const entries = readAuditFile();
    entries.unshift({
      ts: new Date().toISOString(),
      ip: getClientIp(req),
      action: String(action || 'system').slice(0, 60),
      level: ['info', 'ok', 'warn', 'error'].includes(level) ? level : 'info',
      detail: String(detail || '').slice(0, 300)
    });
    if (entries.length > MAX_AUDIT_ENTRIES) entries.length = MAX_AUDIT_ENTRIES;
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    // audit logging must never break primary request flow
  }
}

function listAuditEvents(limit = 100) {
  const safeLimit = Math.max(1, Math.min(MAX_AUDIT_ENTRIES, Number(limit) || 100));
  return readAuditFile().slice(0, safeLimit);
}

module.exports = {
  logAuditEvent,
  listAuditEvents,
  getClientIp
};
