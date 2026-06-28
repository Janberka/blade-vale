'use strict';
// Blade Vale bot — minimal RFC 6455 WebSocket *client* (zero deps), the client-side mirror of the
// server's hand-rolled server/ws.js. Node 20 has no global WebSocket and the project avoids the
// `ws` package, so we roll the handshake + framing with net + crypto. Per spec, client→server
// frames are masked (mask bit + 4-byte XOR key); server→client frames arrive unmasked. We carry
// text frames (the co-op JSON) and answer ping with pong.

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // RFC 6455 magic value (matches server/ws.js)

function connect(url) {
  const u = new URL(url);
  const port = u.port ? +u.port : (u.protocol === 'wss:' ? 443 : 80);
  const ev = new EventEmitter();
  const key = crypto.randomBytes(16).toString('base64');
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');

  let open = false;
  let buf = Buffer.alloc(0);

  const sock = net.connect({ host: u.hostname, port }, () => {
    sock.write(
      'GET ' + (u.pathname || '/') + (u.search || '') + ' HTTP/1.1\r\n' +
      'Host: ' + u.hostname + ':' + port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  function handleFrame(f) {
    if (f.opcode === 0x8) { ev.emit('close'); sock.end(); }            // close
    else if (f.opcode === 0x9) { sock.write(encodeFrame(f.payload, 0xA)); } // ping -> pong
    else if (f.opcode === 0x1 || f.opcode === 0x0) {                   // text / continuation
      let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { return; }
      ev.emit('message', m);
    }
  }

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;                       // headers still arriving
      const head = buf.slice(0, i).toString('utf8');
      buf = buf.slice(i + 4);
      // Verify Sec-WebSocket-Accept = base64(sha1(key + GUID)). The server is RFC 6455-compliant
      // (server/ws.js uses the standard magic GUID), so pinning the exact hash is correct here.
      if (!/HTTP\/1\.1 101/i.test(head) || !head.includes(accept)) {
        ev.emit('error', new Error('handshake failed')); sock.destroy(); return;
      }
      open = true;
      ev.emit('open');
    }
    for (;;) { const f = readFrame(buf); if (!f) break; buf = f.rest; handleFrame(f); }
  });
  sock.on('error', (e) => ev.emit('error', e));
  sock.on('close', () => ev.emit('close'));

  ev.send = (obj) => { if (!open) return false; sock.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1)); return true; };
  ev.close = () => { try { sock.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch (e) {} sock.end(); };
  ev.socket = sock;
  return ev;
}

// pull one frame off buf -> { opcode, payload, rest } or null if not all here yet
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
  else if (len === 127) { if (buf.length < off + 8) return null; len = Number(buf.readBigUInt64BE(off)); off += 8; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
  return { opcode, payload, rest: buf.slice(off + len) };
}

// encode a client->server frame: FIN=1, masked (required of clients)
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | (opcode & 0x0f);
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

module.exports = { connect };
