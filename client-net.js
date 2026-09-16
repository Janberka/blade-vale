/* Blade Vale — client networking layer (window.net).
   Talks to the Node backend for career persistence. Degrades gracefully: if the server is
   unreachable the game still runs (game.js keeps a localStorage mirror), and saves are queued
   in an outbox and flushed on reconnect. Loaded BEFORE game.js so the profile pre-fetch is in
   flight by the time the player clicks "Enter the Vale". */
(function () {
  'use strict';
  // served by the game server itself (port 8787, wrangler dev on 8790, or no port at all — a tunnel or a real host in
  // front of it): the API is on the same origin. A plain static dev server (8099 / 8102) still talks to :8787 next door.
  var SAME = location.port === '' || location.port === '8787' || location.port === '8790';
  var ORIGIN = (typeof window !== 'undefined' && window.BV_API) ||           // set by the page when the API is on another host (the tunnel)
    (SAME && location.origin !== 'null' ? location.origin : location.protocol + '//' + (location.hostname || 'localhost') + ':8787');
  var BASE = String(ORIGIN).replace(/\/+$/, '') + '/api/v1';
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

  // server-worldgen mode: the client FETCHES terrain chunks from the backend instead of
  // generating locally. ?srv=1 turns it on and sticks; ?srv=0 turns it back off.
  var SRV = false;
  try {
    var ss = location.search;
    if (/[?&]srv=0(&|$)/.test(ss)) { localStorage.removeItem('bv-srv'); SRV = false; }
    else if (/[?&]srv(=1)?(&|$)/.test(ss)) { localStorage.setItem('bv-srv', '1'); SRV = true; }
    else SRV = localStorage.getItem('bv-srv') === '1';
  } catch (e) {}

  // Signed-in session (username/password auth). When present, the session token IS the player
  // token — it rides the same X-Player-Token seam and the server resolves it to the account.
  var SESSION = null;
  try { SESSION = JSON.parse(localStorage.getItem('bv-session') || 'null'); } catch (e) {}

  // Player identity → server account. Single-player keeps 'local' (existing progress untouched).
  // Multiplayer needs a DISTINCT token per person, else everyone collapses into one account and
  // nobody sees anybody. Priority: signed-in session → ?p=<name> (readable, assignable) → a name
  // set earlier on this device → a per-device random id when in shared mode → 'local'.
  function playerToken() {                                  // (named: a sign-out in place recomputes it — VR.md)
    try {
      if (SESSION && SESSION.token) return SESSION.token;
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
  }
  var PLAYER_TOKEN = playerToken();
  net.token = PLAYER_TOKEN;
  net.sharedWorld = SHARED;
  net.srvWorld = SRV;
  net.session = SESSION; // {token, username} when signed in, else null

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

  // ----- server feature flags: tunable knobs served at boot (camera feel, etc.). Defaults live here so
  // solo/offline still works; the server can override any of them without a client push. net.config is
  // filled IN PLACE when the fetch resolves, and net.configReady lets the game re-read once it lands.
  net.config = { modeXfadeSpeed: 0.6 };
  net.configReady = jfetch('/config', { method: 'GET' })
    .then(function (r) { if (r && r.flags) { Object.assign(net.config, r.flags); } return net.config; })
    .catch(function () { return net.config; });

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
  net.loadWorld = function (since, x, z) {
    // x/z (the player's map position) scope which settlement patrols the server ships — every
    // named host and anything in a battle/campaign always comes down regardless
    var pos = (x != null && z != null) ? '&x=' + Math.round(x) + '&z=' + Math.round(z) : '';
    return jfetch('/world?since=' + (since != null ? since : lastSeenTick()) + pos, { method: 'GET', headers: worldHeaders() })
      .then(function (w) { net.online = true; net.world = w; if (w && w.holdings) net.holdings = w.holdings; return w; })
      .catch(function () { return null; });
  };
  // ----- server-generated terrain chunks (worldgen Phase 1) -----
  // keys = ['cx:cz', ...]; level/u = the client's mapLevel + universeSeed (shared world ignores them)
  net.loadChunks = function (level, u, keys) {
    var path = '/chunks?level=' + (level | 0) + '&u=' + (u >>> 0) + '&list=' + keys.join(',');
    var opts = { method: 'GET', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, worldHeaders()) };
    return withTimeout(fetch(BASE + path, opts), 20000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      net.online = true;
      return r.json();
    });
  };
  // settlement LAYOUT descriptors (Phase 3): send the (x,z,tier,seed) the client will render, get back
  // the primitive list so the ~160ms placement runs server-side. items = [{key,x,z,tier,seed}, ...].
  net.loadSettlements = function (items) {
    var opts = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, worldHeaders()), body: JSON.stringify({ items: items }) };
    return withTimeout(fetch(BASE + '/settlements', opts), 20000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      net.online = true;
      return r.json();
    });
  };
  // the street-level DETAIL tier (action zoom rung): server-persisted scatter + grove rows
  net.loadDetail = function (level, u, keys) {
    var path = '/chunks/detail?level=' + (level | 0) + '&u=' + (u >>> 0) + '&list=' + keys.join(',');
    var opts = { method: 'GET', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, worldHeaders()) };
    return withTimeout(fetch(BASE + path, opts), 20000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      net.online = true;
      return r.json();
    });
  };
  // the political heat-map layer: per-hex owner + heat for a chunk batch, generated + stored
  // server-side from live ownership (the border layer eases toward THIS truth)
  net.loadTerritory = function (level, u, keys) {
    var path = '/territory?level=' + (level | 0) + '&u=' + (u >>> 0) + '&list=' + keys.join(',');
    var opts = { method: 'GET', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, worldHeaders()) };
    return withTimeout(fetch(BASE + path, opts), 20000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      net.online = true;
      return r.json();
    });
  };
  // one realm's live card (capital, holds by tier, relations, posture) — the click-info panel
  net.loadNation = function (name) {
    return jfetch('/nation?name=' + encodeURIComponent(name), { method: 'GET', headers: worldHeaders() })
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
  // ----- auth: super-simple username/password. Success stores the session and reloads the page
  // so every boot-time fetch (profile, world, chunks) re-runs under the new identity. -----
  // like jfetch, but keeps the server's {ok:false, error} body on 4xx instead of throwing it away
  function jpost(path, body, extraHeaders) {
    var opts = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Player-Token': PLAYER_TOKEN }, extraHeaders || {}), body: JSON.stringify(body || {}) };
    return withTimeout(fetch(BASE + path, opts), TIMEOUT)
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'server unreachable' }; });
  }
  function authCall(path, username, password, stay) {   // stay: set the session in place and do NOT reload (a headset session would end with the page — VR.md)
    return jpost(path, { username: username, password: password }).then(function (r) {
      if (r && r.ok && r.token) {
        try { localStorage.setItem('bv-session', JSON.stringify({ token: r.token, username: r.username })); } catch (e) {}
        if (stay) { SESSION = { token: r.token, username: r.username }; net.session = SESSION; PLAYER_TOKEN = r.token; }
        else location.reload();
      }
      return r;
    });
  }
  net.register = function (u, p, stay) { return authCall('/auth/register', u, p, stay); };
  net.login = function (u, p, stay) { return authCall('/auth/login', u, p, stay); };
  net.logout = function (stay) { try { localStorage.removeItem('bv-session'); } catch (e) {} if (stay) { SESSION = null; net.session = null; PLAYER_TOKEN = playerToken(); return; } location.reload(); };

  // ----- the arena career: XP, gold, ranks, the marketplace (signed-in accounts) -----
  net.arenaCareer = function (seed) { return jfetch('/arena/career' + (seed != null ? '?seed=' + encodeURIComponent(seed) : ''), { method: 'GET' }).then(function (r) { return r && r.career; }).catch(function () { return null; }); };
  net.arenaBuy = function (item) { return jpost('/arena/buy', { item: item }); };
  net.arenaEquip = function (slot, item) { return jpost('/arena/equip', { slot: slot, item: item }); };
  net.arenaLook = function (look) { return jpost('/arena/look', look); };   // the barber: { s, f, h, c, b }
  net.arenaResult = function (result) { return jpost('/arena/result', result); };
  // profiles + the ladder (public reads; the network scope is everyone who shared a pit with you)
  net.arenaProfile = function (name, kind) { return jfetch('/arena/profile?name=' + encodeURIComponent(name) + (kind ? '&kind=' + encodeURIComponent(kind) : ''), { method: 'GET' }).catch(function () { return { ok: false, error: 'the war-net did not answer' }; }); };
  net.arenaDaily = function () { return jfetch('/arena/daily', { method: 'GET' }).catch(function () { return { ok: false, error: 'the war-net did not answer' }; }); };   // the bout of the day and its board
  net.arenaRankings = function (o) { o = o || {}; return jfetch('/arena/rankings?scope=' + (o.scope || 'global') + '&kind=' + (o.kind || 'player') + '&limit=' + (o.limit || 50) + '&offset=' + (o.offset || 0), { method: 'GET' }).catch(function () { return { ok: false, error: 'the war-net did not answer' }; }); };

  // ----- multiple characters per account, same map: adopt / switch / split / give -----
  net.charsList = [];   // last server roster [{charId, name, x, z, men, renown, active}]
  function charsCall(path, body) {
    return jpost('/chars' + path, body, worldHeaders())
      .then(function (r) { if (r && r.chars) net.charsList = r.chars; return r; });
  }
  net.loadChars = function () {
    return jfetch('/chars', { method: 'GET', headers: worldHeaders() })
      .then(function (r) { if (r && r.chars) net.charsList = r.chars; return net.charsList; })
      .catch(function () { return null; });
  };
  net.adoptChar = function (body) { return charsCall('/adopt', body); };
  net.switchChar = function (toId, from) { return charsCall('/switch', { toId: toId, from: from }); };
  net.splitChar = function (body) { return charsCall('/split', body); };
  net.createChar = function (body) { return charsCall('/create', body); };
  net.giveMen = function (fromId, toId, men) { return charsCall('/give', { fromId: fromId, toId: toId, men: men }); };
  net.mergeChar = function (fromId, intoId) { return charsCall('/merge', { fromId: fromId, intoId: intoId }); };
  net.detachMember = function (memberId, men, x, z) { return charsCall('/detach', { memberId: memberId, men: men, x: x, z: z }); };

  // pre-fetch the world alongside the profile so the digest is ready when the player starts
  net.worldReady = net.loadWorld();

  window.net = net;
})();
