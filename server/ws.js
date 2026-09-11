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
//   who                            -> who {list:[{id,name,busy}]}   (everyone online, for arena invites)
//   invite{to,cfg}                 -> the named player gets invite {from,name,room,cfg} | invite-fail {to}
//   dm    {to,data}                -> msg {from,data,dm:true} to ONE connection, room or not (invite replies)
//
// STAYING CONNECTED (phones drop sockets every time you switch apps):
//   * every 10 s the server pings each socket and sends {t:'beat'}; a socket silent for 35 s is reaped —
//     a phone that vanished never closes its TCP socket, and those ghosts used to pile up forever
//   * a socket that DIES (not an explicit leave) keeps its seat for GRACE_MS: the host hears peer-away
//     (or the guests hear host-away) instead of peer-leave / host-gone
//   * hello {resume: room} from the same account takes the seat back -> resumed {room,isHost,oldId,peers};
//     the host hears peer-rejoin {oldId,id,name} (or the guests hear host-back). A still-listed old socket
//     of that account (the server hadn't noticed it die yet) is told 'superseded' and closed.
//   * a seat not reclaimed within GRACE_MS is let go for real: peer-leave / host-gone, exactly as before
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

  const GRACE_MS = opts.graceMs || 25000, BEAT_MS = opts.beatMs || 10000, DEAD_MS = opts.deadMs || 35000;
  // the socket died (not an explicit leave): hold the seat for a grace period instead of giving it away
  function dropConn(conn) {
    conns.delete(conn.id);
    const r = conn.room && rooms.get(conn.room); if (!r) return;
    const wasHost = r.hostId === conn.id;
    (r.away = r.away || new Map()).set(conn.id, { acct: conn.acct, name: conn.name, at: Date.now(), wasHost });
    if (wasHost) { for (const mid of r.members) { if (mid === conn.id) continue; const m = conns.get(mid); if (m) m.send({ t: 'host-away', room: conn.room }); } }
    else { const h = conns.get(r.hostId); if (h) h.send({ t: 'peer-away', room: conn.room, id: conn.id, name: conn.name }); }
  }
  // a seat nobody came back for within the grace period is let go for real
  function expireAway(now) {
    for (const [room, r] of rooms) {
      if (!r.away) continue;
      for (const [oid, a] of r.away) {
        if (now - a.at < GRACE_MS) continue;
        r.away.delete(oid); r.members.delete(oid);
        if (a.wasHost) { for (const mid of r.members) { const m = conns.get(mid); if (m) { m.send({ t: 'host-gone', room }); m.room = null; } } rooms.delete(room); break; }
        const h = conns.get(r.hostId); if (h) h.send({ t: 'peer-leave', room, id: oid });
        if (!r.members.size) rooms.delete(room);
      }
    }
  }
  // take a seat back: the old id's membership (and hosting) passes to the new connection
  function adopt(r, room, oldId, conn, wasHost) {
    r.members.delete(oldId); r.members.add(conn.id); if (r.away) r.away.delete(oldId);
    if (wasHost) r.hostId = conn.id;
    conn.room = room;
    const peers = []; if (wasHost) for (const mid of r.members) { if (mid === conn.id) continue; const c = conns.get(mid); if (c) peers.push({ id: mid, name: c.name }); }
    conn.send({ t: 'resumed', room, isHost: wasHost, oldId, beacon: r.beacon, peers });
    if (wasHost) { for (const mid of r.members) { if (mid === conn.id) continue; const c = conns.get(mid); if (c) c.send({ t: 'host-back', room }); } }
    else { const h = conns.get(r.hostId); if (h) h.send({ t: 'peer-rejoin', room, oldId, id: conn.id, name: conn.name }); }
  }
  function resume(conn, room) {
    const r = rooms.get(room); if (!r) { conn.send({ t: 'resume-fail', room }); return; }
    const same = (a, n) => (conn.acct && a === conn.acct) || (!conn.acct && n === conn.name);
    if (r.away) for (const [oid, a] of r.away) if (same(a.acct, a.name)) { adopt(r, room, oid, conn, a.wasHost); return; }
    for (const mid of r.members) {                            // the server hasn't noticed the old socket die yet: supersede it
      const c = conns.get(mid); if (!c || c === conn || !same(c.acct, c.name)) continue;
      const wasHost = r.hostId === mid;
      c.superseded = true; conns.delete(mid); c.send({ t: 'superseded' }); try { c.socket.destroy(); } catch (e) {}
      adopt(r, room, mid, conn, wasHost); return;
    }
    conn.send({ t: 'resume-fail', room });                     // not in that room any more (the grace ran out)
  }
  const beat = setInterval(() => {
    const now = Date.now();
    for (const [, c] of conns) {
      if (now - (c.lastSeen || now) > DEAD_MS) { try { c.socket.destroy(); } catch (e) {} continue; }   // a ghost: the close handler drops it
      try { c.socket.write(Buffer.from([0x89, 0x00])); } catch (e) {}                                     // ping: a live browser pongs by itself
      c.send({ t: 'beat' });                                                                              // …and a message the page can see, so it can tell a dead link too
    }
    expireAway(now);
  }, BEAT_MS);
  if (beat.unref) beat.unref();

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
        conn.acct = String(m.acct || '').slice(0, 40); conn.hello = true; // acct = signed-in username: the stable invite address
        conn.send({ t: 'hello-ok', id: conn.id });
        if (m.resume && !conn.room) resume(conn, String(m.resume)); // a dropped phone coming back takes its seat back
        break;
      case 'who': {                              // everyone online right now (arena invite roster)
        const list = [];
        for (const [id, c] of conns) if (id !== conn.id && c.hello) list.push({ id, name: c.acct || c.name, busy: !!c.room });
        conn.send({ t: 'who', list }); break;
      }
      case 'invite': {                           // a host invites a named player into its room
        const to = String(m.to || '').slice(0, 40); if (!to || !conn.room) break;
        let sent = 0;
        for (const [id, c] of conns) {
          if (id === conn.id || !c.hello) continue;
          if (c.acct === to || (!c.acct && c.name === to)) { c.send({ t: 'invite', from: conn.id, name: conn.acct || conn.name, room: conn.room, cfg: m.cfg || {} }); sent++; }
        }
        if (!sent) conn.send({ t: 'invite-fail', to });
        break;
      }
      case 'dm': {                               // one-to-one, independent of rooms (invite accept/decline)
        const c = conns.get(m.to | 0); if (c) c.send({ t: 'msg', from: conn.id, data: m.data, dm: true });
        break;
      }
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
    const conn = { id: nextId++, socket, world: 'default', name: 'Ally', room: null, lastSeen: Date.now(),
      send(obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {} } };
    conns.set(conn.id, conn);
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; if (conn.superseded) { conns.delete(conn.id); return; } dropConn(conn); }; // a dead socket keeps its seat for a while
    const parser = makeParser(socket, (msg) => handle(conn, msg), () => { cleanup(); try { socket.end(); } catch (e) {} });
    socket.on('data', (c) => { conn.lastSeen = Date.now(); try { parser(c); } catch (e) { cleanup(); try { socket.destroy(); } catch (e2) {} } });
    socket.on('close', cleanup);
    socket.on('error', () => { cleanup(); try { socket.destroy(); } catch (e) {} });
  });
  if (opts.log !== false) console.log('Blade Vale co-op relay attached on /coop');
  return { rooms, conns, encodeFrame, acceptKey, stop() { clearInterval(beat); } };
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
