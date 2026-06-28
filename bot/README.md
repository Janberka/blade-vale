# Blade Vale — terminal NPC bot

A headless, **manual-puppet** client. It connects to the running server exactly like a real
player — identified only by an `X-Player-Token`, made visible by a presence heartbeat in the
shared world — and does nothing on its own. You drive every action by typing commands.

It speaks the same two protocols the browser client uses, and **only** the public API (it never
touches `world.db`), so to the server it is indistinguishable from a human:

- **HTTP `/api/v1`** (see [`client-net.js`](../client-net.js)) — presence, world reads, hunting
  server armies, taking capitals, career persistence.
- **WebSocket `/coop`** (see [`net-battle.js`](../net-battle.js) and [`server/ws.js`](../server/ws.js))
  — join a real player's hosted battle as an ally.

No new dependencies: Node ≥ 18 has global `fetch`, and the WebSocket client is hand-rolled
(`net` + `crypto`), mirroring the server's own hand-rolled WebSocket.

## Run

The server must be running (`npm run server`). Then, in another terminal:

```bash
npm run bot -- --name "Grimwald the Bold" --token bot-grimwald
# or directly:
node bot/bot.js --name "Grimwald the Bold" --token bot-grimwald
```

Flags: `--name`, `--token` (your identity — reuse it to keep a career), `--faction`,
`--archetype sword|long|archer|thrower`, `--band <n>` (starting followers, default 10),
`--server http://host:port` (default `http://localhost:8787`).

**Fleet:** launch it again in another terminal with a different `--token`/`--name` to populate the
shared world with more NPCs. Each token is a separate, persistent character.

## Commands

| Command | What it does |
| --- | --- |
| `whoami` | Identity, band, renown, position |
| `look` | Refresh and print the shared world around you (armies, capitals, players, events) |
| `pos` / `goto <x> <z>` / `move <dx> <dz>` | Read / set / nudge your map position, then heartbeat |
| `presence` | Force a presence heartbeat now (auto-pulsed every 10s anyway) |
| `hunt <armyId>` | Close on a server army and fight it — resolved honestly via `sim/world-sim.js`; you can lose |
| `siege <capIdx>` | Close on a capital and take it if `band ≥ garrison/2` |
| `career save` | Persist your character + warband to the server |
| `coop connect` / `list` / `join <room>` / `input <dx> <dz>` / `leave` / `status` | Join and fight in a real player's co-op battle |
| `help` / `quit` | — |

## Honest by design

Per the project roadmap (no cheating, legible losses), `hunt` and `siege` are gated by real
proximity and resolved with the same shared kernel the server authority uses
(`WorldSim.resolveClash`). The bot reports a kill or a capture only when it actually earns it; a
lost clash thins (and can break) its band.
