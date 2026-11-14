const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const { URL } = require('node:url');
const { isAuthenticated } = require('./auth');
const { dockerJson } = require('./collectors/docker');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const ALLOW_CONTROL = String(process.env.ALLOW_DOCKER_CONTROL || 'false').toLowerCase() === 'true';

function createWsAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function sendWsFrame(socket, payloadBuf, opcode = 0x1) {
  if (socket.destroyed || !socket.writable) return;
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try {
    socket.write(Buffer.concat([header, payloadBuf]));
  } catch {
    // ignore write after abrupt client disconnect
  }
}

function sendWsText(socket, text) {
  sendWsFrame(socket, Buffer.from(text, 'utf8'), 0x1);
}

const MAX_WS_FRAME_BYTES = 64 * 1024;

function parseWsFrames(buffer, onMessage, onClose) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    if (!Number.isFinite(payloadLen) || payloadLen < 0 || payloadLen > MAX_WS_FRAME_BYTES) {
      onClose();
      return Buffer.alloc(0);
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;

    let payload = buffer.subarray(cursor + maskLen, cursor + maskLen + payloadLen);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    offset = cursor + maskLen + payloadLen;

    if (opcode === 0x8) {
      onClose();
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) {
      // Ping -> Pong
      onMessage({ type: 'ping', data: payload });
      continue;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      onMessage({ type: 'data', data: payload.toString('utf8') });
    }
  }
  return buffer.subarray(offset);
}

async function attachDockerExecTerminal(wsSocket, containerId) {
  if (!ALLOW_CONTROL) {
    sendWsText(wsSocket, '\r\n[Fehler] Container-Terminal erfordert ALLOW_DOCKER_CONTROL=true.\r\n');
    wsSocket.end();
    return;
  }
  if (!containerId || !/^[a-zA-Z0-9_.-]+$/.test(containerId)) {
    sendWsText(wsSocket, '\r\n[Fehler] Ungültige Container-ID.\r\n');
    wsSocket.end();
    return;
  }
  if (!fs.existsSync(DOCKER_SOCKET)) {
    sendWsText(wsSocket, '\r\n[Fehler] /var/run/docker.sock nicht verfügbar.\r\n');
    wsSocket.end();
    return;
  }

  let execId;
  try {
    const created = await dockerJson('POST', `/containers/${encodeURIComponent(containerId)}/exec`, 5000, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi']
    });
    execId = created.Id;
  } catch (err) {
    sendWsText(wsSocket, `\r\n[Fehler] Exec konnte nicht gestartet werden: ${err.message}\r\n`);
    wsSocket.end();
    return;
  }

  const dockerConn = net.createConnection({ path: DOCKER_SOCKET });
  dockerConn.setTimeout(0);
  wsSocket.setTimeout(0);
  const body = JSON.stringify({ Detach: false, Tty: true });
  const rawReq =
    `POST /exec/${execId}/start HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Content-Type: application/json\r\n` +
    `Connection: Upgrade\r\n` +
    `Upgrade: tcp\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

  let headerParsed = false;
  let headBuf = Buffer.alloc(0);

  dockerConn.on('connect', () => {
    dockerConn.write(rawReq);
  });

  dockerConn.on('data', (chunk) => {
    if (!headerParsed) {
      headBuf = Buffer.concat([headBuf, chunk]);
      const idx = headBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      headerParsed = true;
      const rest = headBuf.subarray(idx + 4);
      if (rest.length > 0) sendWsFrame(wsSocket, rest, 0x1);
      return;
    }
    sendWsFrame(wsSocket, chunk, 0x1);
  });

  dockerConn.on('end', () => {
    if (!wsSocket.destroyed) {
      sendWsText(wsSocket, '\r\n[Terminal-Sitzung beendet]\r\n');
      wsSocket.end();
    }
  });

  dockerConn.on('error', (err) => {
    if (!wsSocket.destroyed) {
      sendWsText(wsSocket, `\r\n[Verbindungsfehler] ${err.message}\r\n`);
      wsSocket.end();
    }
  });

  let leftover = Buffer.alloc(0);
  wsSocket.on('data', (chunk) => {
    leftover = parseWsFrames(
      Buffer.concat([leftover, chunk]),
      (msg) => {
        if (msg.type === 'ping') {
          sendWsFrame(wsSocket, msg.data, 0xA);
          return;
        }
        if (!dockerConn.destroyed) {
          dockerConn.write(msg.data);
        }
      },
      () => {
        dockerConn.end();
        wsSocket.end();
      }
    );
  });

  wsSocket.on('close', () => {
    if (!dockerConn.destroyed) dockerConn.end();
  });

  wsSocket.on('error', () => {
    if (!dockerConn.destroyed) dockerConn.destroy();
  });
}

function attachTerminalUpgrade(server) {
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {
      if (!socket.destroyed) socket.destroy();
    });

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }

    if (!isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) {
      socket.destroy();
      return;
    }

    const accept = createWsAccept(wsKey);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const containerId = url.searchParams.get('container') || '';
    attachDockerExecTerminal(socket, containerId);
  });
}

module.exports = {
  attachTerminalUpgrade
};
