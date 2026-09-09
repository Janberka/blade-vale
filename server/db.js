// Blade Vale — SQLite connection + forward-only migration runner.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BV_DB || path.join(__dirname, 'world.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');     // concurrent reads while a write is in flight
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))');
  const cur = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const ver = parseInt(f.slice(0, 3), 10);
    if (ver <= cur) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(ver);
    })();
    console.log('migrated', f);
  }
}

module.exports = { db, migrate, DB_PATH };

if (require.main === module && process.argv.includes('--migrate')) {
  migrate();
  console.log('migrations applied at', DB_PATH);
}
