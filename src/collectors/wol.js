const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const { recordAutomationEvent } = require('./watchdog');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const WOL_FILE = path.join(DATA_DIR, 'wol-devices.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeMac(rawMac) {
  const hex = String(rawMac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) {
    const err = new Error('Ungültige MAC-Adresse (erwartet 6 Hex-Bytes, z. B. AA:BB:CC:DD:EE:FF).');
    err.statusCode = 400;
    throw err;
  }
  return hex.match(/.{2}/g).join(':');
}

function listWolDevices() {
  ensureDataDir();
  if (!fs.existsSync(WOL_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(WOL_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWolDevices(devices = []) {
  ensureDataDir();
  const cleaned = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || typeof d !== 'object') continue;
    const name = String(d.name || '').trim().slice(0, 80);
    if (!name) continue;
    const mac = normalizeMac(d.mac);
    const broadcastIp = String(d.broadcastIp || '255.255.255.255').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(broadcastIp)) {
      const err = new Error(`Ungültige Broadcast-IP: ${broadcastIp}`);
      err.statusCode = 400;
      throw err;
    }
    const port = Math.max(1, Math.min(65535, Number(d.port) || 9));
    cleaned.push({
      id: String(d.id || `wol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      name,
      mac,
      broadcastIp,
      port
    });
  }
  fs.writeFileSync(WOL_FILE, JSON.stringify(cleaned, null, 2), 'utf8');
  return cleaned;
}

function buildMagicPacket(mac) {
  const cleanHex = normalizeMac(mac).replace(/:/g, '');
  const macBytes = Buffer.from(cleanHex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i += 1) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

function sendMagicPacket({ mac, broadcastIp = '255.255.255.255', port = 9, name = '' }) {
  const normalizedMac = normalizeMac(mac);
  const packet = buildMagicPacket(normalizedMac);
  const targetPort = Math.max(1, Math.min(65535, Number(port) || 9));
  const targetIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(String(broadcastIp || '').trim())
    ? String(broadcastIp).trim()
    : '255.255.255.255';

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      try { socket.close(); } catch {}
      reject(err);
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, 0, packet.length, targetPort, targetIp, (err) => {
          try { socket.close(); } catch {}
          if (err) return reject(err);
          recordAutomationEvent(
            'wol',
            'ok',
            `Wake-on-LAN Magic Packet gesendet an ${name ? `"${name}" ` : ''}(${normalizedMac} → ${targetIp}:${targetPort}).`
          );
          resolve({ ok: true, mac: normalizedMac, broadcastIp: targetIp, port: targetPort });
        });
      } catch (err) {
        try { socket.close(); } catch {}
        reject(err);
      }
    });
  });
}

async function wakeDeviceById(id) {
  const devices = listWolDevices();
  const device = devices.find((d) => d.id === id);
  if (!device) {
    const err = new Error('WoL-Gerät nicht gefunden.');
    err.statusCode = 404;
    throw err;
  }
  return await sendMagicPacket(device);
}

module.exports = {
  normalizeMac,
  listWolDevices,
  saveWolDevices,
  sendMagicPacket,
  wakeDeviceById
};
