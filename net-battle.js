/* Blade Vale — real-time co-op battle transport (window.coop).
   A thin WebSocket client over the server's dependency-free /coop relay. The relay only ROUTES
   messages; the battle is HOST-AUTHORITATIVE — the host runs the sim and broadcasts snapshots,
   guests send input and render what they receive. Degrades to nothing if the server is absent, so
   offline single-player is untouched. Loaded before game.js so window.coop exists at boot. */
(function () {
  'use strict';
  function defaultUrl() {
    try { var o = localStorage.getItem('bv-coop-url'); if (o) return o; } catch (e) {}
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + (location.hostname || 'localhost') + ':8787/coop';
  }

  var coop = {
    connected: false, id: null, room: null, isHost: false, peers: [],
    url: defaultUrl(), handlers: {}, name: null, acct: null,
  };
  var ws = null, helloResolve = null;

  // several subsystems (the world co-op and the arena lobby) listen on the same socket, so every
  // type keeps a LIST of handlers; each one guards on its own state and ignores what isn't its business
  coop.on = function (type, fn) { (coop.handlers[type] = coop.handlers[type] || []).push(fn); return coop; };
  function emit(type, m) { var hs = coop.handlers[type] || []; for (var i = 0; i < hs.length; i++) { try { hs[i](m); } catch (e) { /* a handler bug must not kill the socket */ } } }
  function raw(o) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); return true; } catch (e) {} } return false; }

  // shared-world play is the prerequisite for co-op (you need to share a world to meet other players)
  coop.available = function () { return !!(window.net && window.net.sharedWorld); };

  // acct = the signed-in username (the stable address arena invites are sent to); name = how the player is
  // shown. Re-connecting while already connected just re-announces the (possibly new) name/world.
  // the socket RECONNECTS by itself (a server restart used to strand every open lobby): after a drop it
  // retries with a growing delay, re-announces itself, and emits 'reconnect' so the arena can re-host.
  var wantLink = false, retryMs = 1500, retryTimer = null, lastHello = null, pending = [];
  function scheduleRetry() {
    if (!wantLink || retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; if (wantLink && !coop.connected) coop.connect(coop.name, coop.world, coop.acct, true); }, retryMs);
    retryMs = Math.min(retryMs * 1.6, 10000);
  }
  coop.connect = function (name, world, acct, isRetry) {
    coop.name = name || 'Ally'; coop.acct = acct || coop.acct || null; coop.world = world || coop.world || 'default'; wantLink = true;
    var hello = { t: 'hello', name: coop.name, world: coop.world, acct: coop.acct || '' }; lastHello = hello;
    if (coop.connected) { raw(hello); return Promise.resolve(true); }
    if (ws && ws.readyState === 0) return new Promise(function (r) { pending.push(r); });   // a connect is already in flight: ride it
    coop.url = defaultUrl();
    return new Promise(function (resolve) {
      var done = false, finish = function (ok) { if (!done) { done = true; resolve(ok); var ps = pending; pending = []; ps.forEach(function (r) { r(ok); }); } if (!ok) scheduleRetry(); };
      try { ws = new WebSocket(coop.url); } catch (e) { finish(false); return; }
      ws.onopen = function () { raw(hello); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        switch (m.t) {
          case 'hello-ok': { var reopened = !!coop.everConnected && !coop.connected; coop.connected = true; coop.everConnected = true; coop.id = m.id; retryMs = 1500; finish(true); if (reopened) emit('reconnect', m); break; } // a re-hello on a live socket is NOT a reconnect
          case 'hosting': coop.room = m.room; coop.isHost = true; emit('hosting', m); break;
          case 'joined': coop.room = m.room; coop.isHost = false; emit('joined', m); break;
          case 'beacons': emit('beacons', m); break;
          case 'peer-join': coop.peers.push({ id: m.id, name: m.name }); emit('peer-join', m); break;
          case 'peer-leave': coop.peers = coop.peers.filter(function (p) { return p.id !== m.id; }); emit('peer-leave', m); break;
          case 'host-gone': coop.room = null; coop.isHost = false; emit('host-gone', m); break;
          case 'join-fail': emit('join-fail', m); break;
          case 'left': coop.room = null; coop.isHost = false; emit('left', m); break;
          case 'msg': emit('msg', m); break; // { from, data } — battle sync payload
          case 'who': emit('who', m); break;               // { list:[{id,name,busy}] }
          case 'invite': emit('invite', m); break;         // { from, name, room, cfg } — an arena challenge
          case 'invite-fail': emit('invite-fail', m); break;
        }
      };
      ws.onclose = function () { var wasUp = coop.connected; coop.connected = false; coop.room = null; coop.isHost = false; coop.peers = []; if (wasUp) emit('disconnect', {}); scheduleRetry(); };
      ws.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, 2500);
    });
  };

  coop.host = function (beacon) { coop.peers = []; raw({ t: 'host', beacon: beacon || {} }); };
  coop.updateBeacon = function (beacon) { raw({ t: 'beacon', beacon: beacon || {} }); };
  coop.list = function () { raw({ t: 'list' }); };
  coop.join = function (room) { raw({ t: 'join', room: room }); };
  coop.leave = function () { raw({ t: 'leave' }); coop.room = null; coop.isHost = false; coop.peers = []; };
  coop.send = function (data, to) { return raw({ t: 'msg', data: data, to: to }); }; // battle sync to room peers
  coop.who = function () { raw({ t: 'who' }); };                                   // who is online (arena invites)
  coop.invite = function (to, cfg) { return raw({ t: 'invite', to: to, cfg: cfg || {} }); };
  coop.dm = function (to, data) { return raw({ t: 'dm', to: to, data: data }); };  // one player, no room needed
  coop.close = function () { wantLink = false; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } try { if (ws) ws.close(); } catch (e) {} ws = null; coop.connected = false; };

  window.coop = coop;
})();
