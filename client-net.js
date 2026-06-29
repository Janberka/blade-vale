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

  // shared-world (multiplayer) toggle. ?mp turns it on and STICKS (so a bookmarked base URL keeps
  // the tester in the shared world); ?solo or ?mp=0 turns it back off (for the dev's own play).
  var SHARED = false;
  try {
    var s = location.search;
    if (/[?&]solo(=|&|$)/.test(s) || /[?&]mp=0(&|$)/.test(s)) { localStorage.removeItem('bv-mp'); SHARED = false; }
    else if (/[?&]mp(=|&|$)/.test(s)) { localStorage.setItem('bv-mp', '1'); SHARED = true; }
    else SHARED = localStorage.getItem('bv-mp') === '1';
  } catch (e) {}

  // Player identity → server account. Single-player keeps 'local' (existing progress untouched).
  // Multiplayer needs a DISTINCT token per person, else everyone collapses into one account and
  // nobody sees anybody. Priority: ?p=<name> (readable, assignable) → a name set earlier on this
  // device → a per-device random id when in shared mode → 'local'.
  var PLAYER_TOKEN = (function () {
    try {
      var m = /[?&]p=([^&#]+)/.exec(location.search);
      if (m) { var name = (decodeURIComponent(m[1]) || '').slice(0, 32) || 'local'; localStorage.setItem('bv-token', name); return name; }
      var explicit = localStorage.getItem('bv-token');
      if (explicit) return explicit;
      if (SHARED) {
        var k = localStorage.getItem('bv-mp-token');
        if (!k) { k = 'p-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bv-mp-token', k); }
        return k;
      }
      return 'local';
    } catch (e) { return 'local'; }
  })();
  net.token = PLAYER_TOKEN;
  net.sharedWorld = SHARED;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })
    ]);
  }
  function jfetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, opts.headers || {});
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
  function worldHeaders() { return SHARED ? { 'X-World': 'shared' } : {}; }

  net.world = null;
  net.holdings = []; // the player's developed towns (last server view) — mirrored from /world and /holdings
  net.loadWorld = function (since) {
    return jfetch('/world?since=' + (since != null ? since : lastSeenTick()), { method: 'GET', headers: worldHeaders() })
      .then(function (w) { net.online = true; net.world = w; if (w && w.holdings) net.holdings = w.holdings; return w; })
      .catch(function () { return null; });
  };
  net.reportCapital = function (idx, owner, summary) {
    return jfetch('/world/capital', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ idx: idx, owner: owner, summary: summary }) }).catch(function () { return null; });
  };
  // ----- town management: develop the holds you own (server-backed economy) -----
  net.reportHold = function (holdKey, defName, tier, x, z) { // claim a conquered hold's economy row (idempotent)
    return jfetch('/holdings/claim', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ holdKey: holdKey, defName: defName, tier: tier, x: x, z: z }) }).catch(function () { return null; });
  };
  net.loadHoldings = function () {
    return jfetch('/holdings', { method: 'GET', headers: worldHeaders() })
      .then(function (h) { net.online = true; net.holdings = (h && h.holdings) || []; return net.holdings; })
      .catch(function () { return null; });
  };
  // server-owned frontier settlements near a point (shared world): who currently holds each
  net.loadHolds = function (x, z, r) {
    var qs = (x != null && z != null) ? ('?x=' + Math.round(x) + '&z=' + Math.round(z) + (r != null ? '&r=' + Math.round(r) : '')) : '';
    return jfetch('/holds' + qs, { method: 'GET', headers: worldHeaders() })
      .then(function (res) { net.online = true; return (res && res.holds) || []; })
      .catch(function () { return null; });
  };
  net.buildHold = function (holdKey, building) {
    return jfetch('/holdings/build', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ holdKey: holdKey, building: building }) }).catch(function () { return null; });
  };
  net.assignHold = function (holdKey, jobs) {
    return jfetch('/holdings/assign', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ holdKey: holdKey, jobs: jobs }) }).catch(function () { return null; });
  };
  net.levyHold = function (holdKey) {
    return jfetch('/holdings/levy', { method: 'POST', headers: worldHeaders(), body: JSON.stringify({ holdKey: holdKey }) }).catch(function () { return null; });
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
