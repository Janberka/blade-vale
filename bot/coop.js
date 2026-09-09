'use strict';
// Blade Vale bot — co-op battle session (guest role). Speaks the /coop relay protocol exactly as
// net-battle.js does on the browser side and server/ws.js expects on the server side. The bot
// joins a real player's hosted battle and fights as an ally: it announces its roster, sends
// movement input, and digests the host's authoritative snapshots. Hosting an authoritative battle
// is out of scope — the bot is always a guest.

const { connect } = require('./net-ws');

function makeCoop({ url, name, world, rosterFn, log }) {
  let ws = null, id = null, room = null, connected = false, lastSnap = null;

  function send(obj) { return (ws && connected) ? ws.send(obj) : false; }

  function onMessage(m) {
    switch (m.t) {
      case 'hello-ok': id = m.id; log('co-op relay: connected (id ' + id + ')'); break;
      case 'beacons': printBeacons(m.list || []); break;
      case 'joined':
        room = m.room;
        log('joined battle ' + room + ' — host ' + ((m.beacon && m.beacon.host) || '?') +
            ', enemy ' + ((m.beacon && m.beacon.enemy) || '?') + ' (' + ((m.beacon && m.beacon.enemyFaction) || '?') + ')');
        send({ t: 'msg', data: { k: 'join-roster', name, roster: rosterFn() } }); // host spawns our warband
        break;
      case 'join-fail': log('join failed — room ' + m.room + ' not found'); break;
      case 'left': room = null; log('left the battle'); break;
      case 'host-gone': log('the host left — battle ' + m.room + ' dissolved'); room = null; break;
      case 'peer-join': log('a peer joined: ' + (m.name || ('#' + m.id))); break;
      case 'peer-leave': log('a peer left: #' + m.id); break;
      case 'msg': onRelay(m.data); break;
    }
  }

  function onRelay(d) {
    if (!d || typeof d !== 'object') return;
    if (d.k === 'snap') lastSnap = d;                       // host's authoritative frame (quiet; see "coop status")
    else if (d.k === 'end') log('battle ended — host reports ' + (d.won ? 'VICTORY' : 'defeat'));
  }

  function printBeacons(list) {
    if (!list.length) { log('no joinable battles right now.'); return; }
    log('joinable battles:');
    for (const b of list) {
      const x = b.beacon || {};
      log('  ' + b.room + '  host=' + (x.host || '?') + ' faction=' + (x.faction || '?') +
          ' enemy=' + (x.enemy || '?') + '(' + (x.enemyFaction || '?') + ') lvl=' + (x.lvl || '?') + ' players=' + b.players);
    }
  }

  return {
    connect() {
      return new Promise((resolve) => {
        ws = connect(url);
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        ws.on('open', () => { connected = true; ws.send({ t: 'hello', name, world }); done(true); });
        ws.on('message', onMessage);
        ws.on('error', (e) => { log('co-op socket error: ' + e.message); done(false); });
        ws.on('close', () => { connected = false; room = null; log('co-op relay: disconnected'); });
        setTimeout(() => done(false), 3000);
      });
    },
    list() { send({ t: 'list' }); },
    join(r) { send({ t: 'join', room: r }); },
    leave() { send({ t: 'leave' }); room = null; },
    input(dx, dz) { send({ t: 'msg', data: { k: 'input', mv: [+(+dx).toFixed(2), +(+dz).toFixed(2)] } }); },
    status() {
      const s = lastSnap;
      const pl = s && s.pl;
      return {
        connected, id, room,
        lastSnap: s ? { host: pl ? { x: pl[0] / 10, z: pl[1] / 10, alive: !!pl[3] } : null, allies: (s.al || []).length, enemies: (s.en || []).length } : null,
      };
    },
    disconnect() { if (ws) ws.close(); },
  };
}

module.exports = { makeCoop };
