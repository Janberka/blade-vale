'use strict';
// Blade Vale bot — HTTP client. The client-side mirror of client-net.js: it talks to the Node
// backend over the public /api/v1 surface, identified ONLY by an X-Player-Token (the server
// auto-creates the account on first request — server/seed.js ensureAccount). Career calls land in
// the bot's own solo world (no X-World header), exactly like a real player; map calls carry
// X-World: shared so the bot is visible to — and can see — everyone in the shared world.
// Node 20 has global fetch, so there are no dependencies here.

const TIMEOUT = 4000;

function makeHttp(cfg) {
  const base = (cfg.server || 'http://localhost:8787').replace(/\/$/, '') + '/api/v1';
  const token = cfg.token || 'bot';

  async function jfetch(path, { method = 'GET', body = null, shared = false } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Player-Token': token };
    if (shared) headers['X-World'] = 'shared';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(base + path, {
        method, headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base, token,
    // career (private solo world — like a real player's own save)
    profile: () => jfetch('/profile'),
    saveCareers: (payload) => jfetch('/careers', { method: 'POST', body: payload }),
    saveDeeds: (deeds) => (deeds && deeds.length) ? jfetch('/deeds', { method: 'POST', body: { deeds } }) : Promise.resolve(null),
    // shared living world
    loadWorld: (since = 0) => jfetch('/world?since=' + (since | 0), { shared: true }),
    sendPresence: (info) => jfetch('/world/presence', { method: 'POST', body: info, shared: true }),
    reportArmyDefeat: (armyId) => jfetch('/world/army/defeat', { method: 'POST', body: { armyId }, shared: true }),
    reportCapital: (idx, owner, summary) => jfetch('/world/capital', { method: 'POST', body: { idx, owner, summary }, shared: true }),
  };
}

module.exports = { makeHttp };
