const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3195;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'homeserver-test-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const MEDIA_DIR = path.join(TMP_ROOT, 'media');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let serverProc;

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not become healthy in time');
}

test.before(async () => {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      ALLOW_FILE_WRITE: 'true',
      MEDIA_PATHS: MEDIA_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth();
});

test.after(async () => {
  if (serverProc) serverProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

test('Security headers include CSP and nosniff', async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
});

test('Streaming file upload writes directly to disk', async () => {
  const payload = Buffer.alloc(256 * 1024, 0x41);
  const res = await fetch(
    `${BASE_URL}/api/files/upload?dir=${encodeURIComponent(MEDIA_DIR)}&name=stream_test.bin`,
    { method: 'POST', body: payload }
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.sizeBytes, payload.length);
  const onDisk = fs.readFileSync(path.join(MEDIA_DIR, 'stream_test.bin'));
  assert.equal(onDisk.length, payload.length);
});

test('Trash retention syncs with scheduler and enforces 409 conflict', async () => {
  const schedRes = await fetch(`${BASE_URL}/api/automation/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [{ id: 't1', name: 'Trash 14d', type: 'trash-cleanup', target: '14', time: '03:00', enabled: true }]
    })
  });
  assert.equal(schedRes.status, 200);

  const f = path.join(MEDIA_DIR, 'retention.txt');
  fs.writeFileSync(f, 'original');
  const delRes = await fetch(`${BASE_URL}/api/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [f] })
  });
  assert.equal(delRes.status, 200);

  const trash = await (await fetch(`${BASE_URL}/api/files/trash`)).json();
  assert.equal(trash.retentionDays, 14);
  assert.equal(trash.items[0].retentionDays, 14);

  fs.writeFileSync(f, 'replacement');
  const conflictRes = await fetch(`${BASE_URL}/api/files/trash/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashKeys: [trash.items[0].trashKey], conflictMode: 'check' })
  });
  assert.equal(conflictRes.status, 409);
});

test('LAN Speedtest endpoints (ping, download, upload)', async () => {
  const ping = await fetch(`${BASE_URL}/api/net/ping`);
  assert.equal(ping.status, 200);
  const pingData = await ping.json();
  assert.equal(pingData.ok, true);

  const dl = await fetch(`${BASE_URL}/api/net/download?mb=1`);
  assert.equal(dl.status, 200);
  const dlBuf = await dl.arrayBuffer();
  assert.equal(dlBuf.byteLength, 1024 * 1024);

  const ul = await fetch(`${BASE_URL}/api/net/upload`, {
    method: 'POST',
    body: new Uint8Array(512 * 1024)
  });
  assert.equal(ul.status, 200);
  const ulData = await ul.json();
  assert.equal(ulData.receivedBytes, 512 * 1024);
});

test('SSE stream delivers live snapshot and closes cleanly', async () => {
  const ac = new AbortController();
  const res = await fetch(`${BASE_URL}/api/stream`, { signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!text.includes('data: {')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  assert.match(text, /data: \{/);
  ac.abort();
});

test('Auth cookie sets Secure flag behind HTTPS proxy', async () => {
  const auth = require('../src/auth');
  const httpCookie = auth.createSessionCookie({ headers: {}, socket: { encrypted: false } });
  const httpsCookie = auth.createSessionCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: { encrypted: false } });
  assert.equal(httpCookie.includes('; Secure'), false);
  assert.equal(httpsCookie.includes('; Secure'), true);
});
