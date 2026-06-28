// Blade Vale — dependency-free WebSocket co-op relay (RFC 6455 subset, no `ws` package).
// Real-time two-player battles: the HOST client runs the authoritative battle sim and broadcasts
// snapshots; GUESTS send input and render what they receive. This server only ROUTES messages and
// tracks room membership + joinable "beacons" (battles allies can ride into). No battle logic here.
//
// Protocol (JSON text frames), client→server `t`:
//   hello {name,world} -> hello-ok {id}
//   host  {room?,beacon}            -> hosting {room}              (registers a joinable beacon)
//   beacon{beacon}                  (host updates its beacon)
//   list                           -> beacons {list:[{room,beacon,players}]}
//   join  {room}                   -> joined {room,beacon} | join-fail ; host gets peer-join {id,name}
//   leave                          ; peers get peer-leave {id}  (host leaving -> guests get host-gone)
//   msg   {data,to?}               -> relayed to room peers as msg {from,data}  (host<->guest sync)
const crypto = require('crypto');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

// encode an unmasked server→client text frame
function encodeFrame(str) {
  const data = Buffer.from(str, 'utf8'), len = data.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, data]);
}
const closeFrame = () => Buffer.from([0x88, 0]);
const pongFrame = () => Buffer.from([0x8a, 0]);

// streaming frame parser: handles masking + fragmentation (text only; control frames acted on inline)
function makeParser(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0), frags = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const mask = buf.subarray(off, off + 4); off += 4;
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
      } else payload = buf.subarray(off, off + len);
      off += len; buf = buf.subarray(off);
      if (opcode === 0x8) { try { socket.write(closeFrame()); } catch (e) {} onClose(); return; }
      if (opcode === 0x9) { try { socket.write(pongFrame()); } catch (e) {} continue; } // ping -> pong
      if (opcode === 0xa) continue;                                                      // pong
      if (opcode === 0x1 || opcode === 0x0) { frags.push(payload); if (fin) { const m = Buffer.concat(frags).toString('utf8'); frags = []; onMessage(m); } }
    }
  };
}

// attach the relay to an existing http.Server. Only upgrades on the /coop path are handled.
function attach(server, opts) {
  opts = opts || {};
  let nextId = 1;
  const conns = new Map();  // id -> conn
  const rooms = new Map();  // room -> { hostId, beacon, members:Set, world }

  function leaveRoom(conn) {
    const r = conn.room && rooms.get(conn.room); if (!r) { conn.room = null; return; }
    r.members.delete(conn.id);
    if (conn.id === r.hostId) {                 // host left → close the room
      for (const mid of r.members) { const m = conns.get(mid); if (m) { m.send({ t: 'host-gone', room: conn.room }); m.room = null; } }
      rooms.delete(conn.room);
    } else {
      const h = conns.get(r.hostId); if (h) h.send({ t: 'peer-leave', room: conn.room, id: conn.id });
      if (!r.members.size) rooms.delete(conn.room);
    }
    conn.room = null;
  }
  function handle(conn, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.t) {
      case 'hello':
        conn.world = String(m.world || 'default'); conn.name = String(m.name || 'Ally').slice(0, 40);
        conn.send({ t: 'hello-ok', id: conn.id }); break;
      case 'host': {
        leaveRoom(conn);
        const room = String(m.room || ('r' + conn.id + '_' + (nextId++)));
        rooms.set(room, { hostId: conn.id, beacon: m.beacon || {}, members: new Set([conn.id]), world: conn.world });
        conn.room = room; conn.send({ t: 'hosting', room }); break;
      }
      case 'beacon': { const r = rooms.get(conn.room); if (r && r.hostId === conn.id && m.beacon) r.beacon = m.beacon; break; }
      case 'list': {
        const list = [];
        for (const [room, r] of rooms) if (r.world === conn.world && r.hostId !== conn.id) list.push({ room, beacon: r.beacon, players: r.members.size });
        conn.send({ t: 'beacons', list }); break;
      }
      case 'join': {
        const r = rooms.get(String(m.room)); if (!r) { conn.send({ t: 'join-fail', room: m.room }); break; }
        leaveRoom(conn);
        r.members.add(conn.id); conn.room = String(m.room);
        conn.send({ t: 'joined', room: conn.room, beacon: r.beacon });
        const h = conns.get(r.hostId); if (h) h.send({ t: 'peer-join', room: conn.room, id: conn.id, name: conn.name }); break;
      }
      case 'leave': leaveRoom(conn); conn.send({ t: 'left' }); break;
      case 'msg': {                              // host<->guest sync: relay to the rest of the room
        const r = rooms.get(conn.room); if (!r) break;
        for (const mid of r.members) { if (mid === conn.id) continue; if (m.to && mid !== m.to) continue; const c = conns.get(mid); if (c) c.send({ t: 'msg', from: conn.id, data: m.data }); }
        break;
      }
    }
  }

  server.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== '/coop') { socket.destroy(); return; } // leave non-coop upgrades alone
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
    socket.setNoDelay(true);
    const conn = { id: nextId++, socket, world: 'default', name: 'Ally', room: null,
      send(obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {} } };
    conns.set(conn.id, conn);
    const cleanup = () => { leaveRoom(conn); conns.delete(conn.id); };
    const parser = makeParser(socket, (msg) => handle(conn, msg), () => { cleanup(); try { socket.end(); } catch (e) {} });
    socket.on('data', (c) => { try { parser(c); } catch (e) { cleanup(); try { socket.destroy(); } catch (e2) {} } });
    socket.on('close', cleanup);
    socket.on('error', () => { cleanup(); try { socket.destroy(); } catch (e) {} });
  });
  if (opts.log !== false) console.log('Blade Vale co-op relay attached on /coop');
  return { rooms, conns, encodeFrame, acceptKey };
}

module.exports = { attach, encodeFrame, acceptKey };

// standalone self-test relay: `node server/ws.js [port]`  (a browser/native WebSocket can connect)
if (require.main === module) {
  const http = require('http');
  const port = parseInt(process.argv[2] || '8799', 10);
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('coop relay\n'); });
  attach(srv);
  srv.listen(port, () => console.log('coop relay test server on :' + port + ' (ws path /coop)'));
}
