# Blade Vale — backend

Node + SQLite (`better-sqlite3`) backend that persists **named-character careers** and runs the
**always-on living world** (the off-map wars keep going while you're logged off). The real-time
battle you personally fight stays in the browser and reports its result here.

## Run

```bash
npm install            # installs better-sqlite3 (prebuilt binary; no compiler needed)
npm run migrate        # apply schema migrations  (server/migrations/*.sql)
npm run seed           # create the 'local' account + world
npm run server         # start the API on :8787   (use `npm run dev` for --watch)
```

Then serve the client (`index.html` / `game.js`) however you normally do; it talks to
`http://localhost:8787` via `client-net.js`. If the server is down the game still runs from a
localStorage mirror and flushes a save outbox on reconnect.

### 24/7 (macOS)

```bash
bash server/install-launchd.sh install     # KeepAlive launchd agent on :8787
bash server/install-launchd.sh uninstall
```

## Layout

| File | Role |
|---|---|
| `db.js` | SQLite connection (WAL) + forward-only migration runner |
| `migrations/001_init.sql` | accounts · worlds · characters · deeds |
| `migrations/002_world.sql` | capitals · warlords · world_events (+ `worlds.sim_tick/last_tick_at/active_until`) |
| `seed.js` | `ensureAccount(token)` — the auth seam (single-player = `local`; MP = one token per player) |
| `tick.js` | the world tick: time-driven advance, heartbeat, `WorldSim` clashes, bounded growth |
| `index.js` | HTTP API (node:http + CORS) |
| `validate.js` | server-side plausibility caps on reported careers |

## API (`/api/v1`, header `X-Player-Token`)

| Method · Path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /profile` | the player's character + warband |
| `POST /careers` | upsert careers (validated) + retire the fallen |
| `POST /deeds` · `GET /deeds` | append / read the kill chronicle |
| `GET /world?since=N` | capitals, warlords, and the events since tick N (the "while you were away" digest); catches the world up on return |
| `POST /world/capital` | report a player conquest |
| `POST /_advance` | **dev/test only** — force N world ticks immediately |

## How the world tick stays sane

- **Time-driven**, not increment-driven: each advance runs `floor((now − last_tick_at) / TICK_SECONDS)`
  ticks, clamped to `MAX_CATCHUP_TICKS`. Sleep, restart, and a week-long absence are one code path.
- **No double-simulation**: every `GET /world` marks the world *active* for `ACTIVE_TTL`; the
  heartbeat only advances worlds with no live session.
- **Bounded growth**: `world_events` capped at 250; fallen warlords pruned to the 60 most-renowned
  "legends". The player's own characters (`characters` table) are never pruned.
