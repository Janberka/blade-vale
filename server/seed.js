// Blade Vale — resolve (or create) the account + world for a player token.
// The auth seam: single-player uses the token 'local'; multiplayer issues a distinct token
// per player, which maps to a distinct, isolated world — no query changes needed to get there.
const { db, migrate } = require('./db');
const tick = require('./tick');

function ensureAccount(handle) {
  handle = (handle && String(handle).slice(0, 64)) || 'local';
  let acct = db.prepare('SELECT * FROM accounts WHERE handle = ?').get(handle);
  if (!acct) {
    const r = db.prepare('INSERT INTO accounts(handle) VALUES (?)').run(handle);
    acct = { id: r.lastInsertRowid, handle };
  }
  let world = db.prepare('SELECT * FROM worlds WHERE account_id = ?').get(acct.id);
  if (!world) {
    const seed = (Date.now() % 1000000000) | 0;
    const r = db.prepare('INSERT INTO worlds(account_id, seed, last_tick_at) VALUES (?, ?, ?)').run(acct.id, seed, Math.floor(Date.now() / 1000));
    world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(r.lastInsertRowid);
    tick.seedWorld(world.id);
  }
  return { acct, world };
}
function ensureLocal() { return ensureAccount('local'); }

module.exports = { ensureLocal, ensureAccount };

if (require.main === module) {
  migrate();
  const { acct, world } = ensureLocal();
  console.log('seeded account', acct.id, '/ world', world.id, '(seed ' + world.seed + ')');
}
