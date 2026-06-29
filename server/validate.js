// Blade Vale — server-side plausibility caps.
// The client reports its own careers, so the server clamps every field to a believable range
// before persisting. Generous in single-player; the same seam tightens for multiplayer where
// reports can't be trusted. Never throws — it sanitises and returns a safe row.
function num(v, def, min, max) {
  v = +v;
  if (!isFinite(v)) v = def;
  return Math.max(min, Math.min(max, v));
}
function clampSkills(s) {
  s = s || {};
  const o = {};
  for (const k of ['strike', 'guard', 'lead', 'aim']) o[k] = num(s[k], 0, 0, 1000); // raw accumulator; effSkill saturates anyway
  return o;
}
function clampChar(c) {
  c = c || {};
  return {
    id: c.id | 0,
    name: String(c.name || 'Unknown').slice(0, 48),
    archetype: String(c.archetype || 'sword').slice(0, 16),
    isPlayer: !!c.isPlayer,
    trait: c.trait ? String(c.trait).slice(0, 24) : null,
    skills: clampSkills(c.skills),
    xp: num(c.xp, 0, 0, 1e9) | 0,
    renown: num(c.renown, 0, 0, 1e6),
    popularity: num(c.popularity, 0, 0, 1e6),
    rank: String(c.rank || 'Recruit').slice(0, 24),
    kills: num(c.kills, 0, 0, 1e7) | 0,
    battles: num(c.battles, 0, 0, 1e7) | 0,
    battlesLed: num(c.battlesLed, 0, 0, 1e7) | 0,
    battlesWon: num(c.battlesWon, 0, 0, 1e7) | 0,
    deaths: num(c.deaths, 0, 0, 1e7) | 0,
    notability: num(c.notability, 1, 0, 3) | 0
  };
}
// ----- town holdings -----
// hold_key is the client siteKey "cx,cz,idx" (cx/cz may be negative, idx >= 0) or "cap:<idx>".
const HOLD_KEY_RE = /^(-?\d+,-?\d+,\d+|cap:\d+)$/;
const HOLD_TIERS = ['village', 'town', 'city', 'capital'];
function holdKeyOk(k) { return HOLD_KEY_RE.test(String(k || '')); }
function clampHold(b) {
  b = b || {};
  const holdKey = String(b.holdKey || '');
  if (!holdKeyOk(holdKey)) return { ok: false, reason: 'bad hold key' };
  let tier = String(b.tier || 'village');
  if (HOLD_TIERS.indexOf(tier) < 0) tier = 'village';
  return { ok: true, holdKey, defName: String(b.defName || 'Holding').slice(0, 48), tier, x: num(b.x, 0, -1e5, 1e5), z: num(b.z, 0, -1e5, 1e5) };
}
module.exports = { clampChar, num, clampHold, holdKeyOk };
