// Blade Vale — super-simple username/password auth (scrypt + bearer sessions).
// Rides the existing X-Player-Token seam: a login mints a random session token, and
// index.js resolves session tokens BEFORE falling back to the legacy handle-as-token
// path. A handle that has a password can no longer be used bare (no bypass), and
// registering a name that exists as a passwordless legacy handle CLAIMS it — so a
// tester who has been playing as ?p=vic keeps their progress when they register "vic".
const crypto = require('crypto');
const { db } = require('./db');

const NAME_RE = /^[a-zA-Z0-9_\-]{2,24}$/;

function hashPw(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function checkPw(acct, password) {
  if (!acct.pass_hash || !acct.pass_salt) return false;
  const h = Buffer.from(hashPw(password, acct.pass_salt), 'hex');
  const w = Buffer.from(acct.pass_hash, 'hex');
  return h.length === w.length && crypto.timingSafeEqual(h, w);
}
function mintSession(accountId) {
  const token = 's-' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token, account_id) VALUES (?,?)').run(token, accountId);
  return token;
}

function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!NAME_RE.test(username)) return { ok: false, error: 'username: 2-24 letters/digits/_/-' };
  if (password.length < 4) return { ok: false, error: 'password: at least 4 characters' };
  let acct = db.prepare('SELECT * FROM accounts WHERE handle=?').get(username);
  if (acct && acct.pass_hash) return { ok: false, error: 'that name is taken' };
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = hashPw(password, salt);
  if (acct) db.prepare('UPDATE accounts SET pass_salt=?, pass_hash=? WHERE id=?').run(salt, hash, acct.id); // claim a legacy handle
  else {
    const r = db.prepare('INSERT INTO accounts(handle, pass_salt, pass_hash) VALUES (?,?,?)').run(username, salt, hash);
    acct = { id: r.lastInsertRowid, handle: username };
  }
  return { ok: true, token: mintSession(acct.id), username };
}

function login(username, password) {
  const acct = db.prepare('SELECT * FROM accounts WHERE handle=?').get(String(username || '').trim());
  if (!acct || !acct.pass_hash) return { ok: false, error: 'no such user — create the account first' };
  if (!checkPw(acct, password)) return { ok: false, error: 'wrong password' };
  return { ok: true, token: mintSession(acct.id), username: acct.handle };
}

// token → account row, or null if it isn't a session token
function resolveSession(token) {
  if (!token || token.slice(0, 2) !== 's-') return null;
  return db.prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=?').get(token) || null;
}
// legacy handle-as-token — refused once the handle has a password (that would bypass it)
function handleLocked(handle) {
  const a = db.prepare('SELECT pass_hash FROM accounts WHERE handle=?').get(String(handle || ''));
  return !!(a && a.pass_hash);
}

module.exports = { register, login, resolveSession, handleLocked };
