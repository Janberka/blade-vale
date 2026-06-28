/* Blade Vale — client networking layer (window.net).
   Talks to the Node backend for career persistence. Degrades gracefully: if the server is
   unreachable the game still runs (game.js keeps a localStorage mirror), and saves are queued
   in an outbox and flushed on reconnect. Loaded BEFORE game.js so the profile pre-fetch is in
   flight by the time the player clicks "Enter the Vale". */
(function () {
  'use strict';
  var BASE = (location.protocol + '//' + (location.hostname || 'localhost') + ':8787') + '/api/v1';
  var TIMEOUT = 2500;
  var OUTBOX_KEY = 'bv-careers-outbox';

  var net = { online: false, profile: null, base: BASE };

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })
    ]);
  }
  function jfetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': 'local' }, opts.headers || {});
    return withTimeout(fetch(BASE + path, opts), TIMEOUT).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function queueOutbox(payload) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(payload)); } catch (e) {} } // single profile → last-write-wins
  function flushOutbox() {
    var raw = null;
    try { raw = localStorage.getItem(OUTBOX_KEY); } catch (e) {}
    if (!raw) return;
    jfetch('/careers', { method: 'POST', body: raw })
      .then(function () { try { localStorage.removeItem(OUTBOX_KEY); } catch (e) {} })
      .catch(function () {});
  }

  // pre-fetch the player's profile so the (synchronous) game boot can read net.profile
  net.ready = jfetch('/profile', { method: 'GET' })
    .then(function (profile) { net.online = true; net.profile = profile; flushOutbox(); return profile; })
    .catch(function () { net.online = false; return null; });

  net.cachedProfile = function () { return net.profile; };

  net.saveCareers = function (payload) {
    return jfetch('/careers', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { net.online = true; return r; })
      .catch(function () { net.online = false; queueOutbox(payload); return null; });
  };

  net.saveDeeds = function (deeds) {
    if (!deeds || !deeds.length) return Promise.resolve(null);
    return jfetch('/deeds', { method: 'POST', body: JSON.stringify({ deeds: deeds }) }).catch(function () { return null; });
  };

  // ----- the always-on living world (Step 4) + positional armies & multiplayer presence (refinements) -----
  function lastSeenTick() { try { return parseInt(localStorage.getItem('bv-lastseen-tick') || '0', 10) || 0; } catch (e) { return 0; } }
  // shared-world (multiplayer) toggle: ?mp in the URL, or localStorage 'bv-mp'
  var SHARED = false;
  try { SHARED = /[?&]mp(=|&|$)/.test(location.search) || localStorage.getItem('bv-mp') === '1'; } catch (e) {}
  net.sharedWorld = SHARED;
  function worldHeaders() { return SHARED ? { 'X-World': 'shared' } : {}; }

  net.world = null;
  net.loadWorld = function (since) {
    return jfetch('/world?since=' + (since != null ? since : lastSeenTick()), { method: 'GET', headers: worldHeaders() })
      .then(function (w) { net.online = true; net.world = w; return w; })
      .catch(function () { return null; });
  };
  net.reportCapital = function (idx, owner, summary) {
    return jfetch('/world/capital', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ idx: idx, owner: owner, summary: summary }) }).catch(function () { return null; });
  };
  net.sendPresence = function (info) { // the player's banner heartbeat (multiplayer)
    return jfetch('/world/presence', { method: 'POST', headers: worldHeaders(), body: JSON.stringify(info) }).catch(function () { return null; });
  };
  net.reportArmyDefeat = function (armyId) { // you broke this server army in person
    return jfetch('/world/army/defeat', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ armyId: armyId }) }).catch(function () { return null; });
  };
  net.diplomacy = function () { // the authoritative faction relations + posture from the last world poll
    return net.world ? { relations: net.world.relations || [], factionState: net.world.factionState || [] } : null;
  };
  // pre-fetch the world alongside the profile so the digest is ready when the player starts
  net.worldReady = net.loadWorld();

  window.net = net;
})();
