# Blade Vale — Arena first, then the endless world

**One line:** a team sword-and-bow brawl in a Colosseum you can open on any phone in ten seconds, with your friends in the same pit and your fighter's career following you between fights — and, when it has an audience, the pit's gates open onto a persistent world that generates itself wherever real people go.

**The plan changed on 2026-09-12.** The endless world (the deterministic worldgen, the always-on five-nation war, the self-play battle AI) is built and still runs, but it is the *harder* product to make legible to a stranger. **Arena Fights** turned out to be the easier thing to finish, the easier thing to show, and the thing that can spread. So: the arena is the product. The open world is hidden from the title screen (`?world` brings it back) and comes later as an expansion of the arena — not the other way round.

---

## What Arena Fights is

- **A lobby, a pit, a bell.** Pick teams (2–6) and fighters per team (1–200), invite anyone online, and every empty seat is a fighter of the vale. Choose the pit, the hour, the sky, the ground, the foes' experience. Start. A Gladiator-style entrance film, a countdown, then the fight.
- **The fight is the asset.** Hold-to-load swings (tap = light, hold = heavy), blocks with blade locks and ripostes, rolls, bows for everyone, horses with real weight. Poise → stagger → execution. NPC packs with captains, ranks, flanks, archer lines and cavalry cycles; six archetypes across an XP curve from green to veteran.
- **The look is ours.** Real sculpted fighters (knight / centurion / hoplite) skinned onto the game's own rig, and every fighter carries the five Vale signatures (`CHARACTERS.md`). A Colosseum with a 10 m podium wall, a stone cavea, a shader-driven crowd of thousands, ruins outside. When a clip goes round, people should know whose it is.
- **A career that follows you.** XP, gold, ranks (Rookie → Legend), a marketplace of gear locked by rank and use-skill, uniques, trophies, achievements. Fights pay out server-side, idempotently, to every account in the pit.
- **Friends on phones.** Host-authoritative multiplayer over the existing relay with reconnect and seat resume, because phones drop sockets on every app switch.

## Why arena first

1. **It is finishable.** A pit is a closed system: no worldgen edge cases, no 24/7 tick, no interest management, no frontier ownership. Every feature is visible in the first minute of play.
2. **It is showable.** Thirty seconds of the entrance film and a kill is a complete pitch. A living hex world needs an hour and a narrator.
3. **It is where the strongest code already is.** The 30-second combat loop, the character work, the Colosseum, the relay — all of it was built for and proven in the pit.
4. **It funds the rest.** The open world is the long-term moat. The arena is how we earn the audience and the runway to ship it.

## What the arena grows into

The open world is not cancelled; it is the *expansion*. The order is deliberate:

1. **The pit** — solo and with friends, careers, retention loop, shareable clips. *(now)*
2. **The circuit** — matchmaking by trophies, seasons, a battle pass, quests, spectating. The arena as a live service.
3. **Beyond the gates** — your arena fighter walks out of the tunnel onto the vale: the same character, the same gear, into the world that already exists behind the flag (warbands, roads, sieges, the living war). The arena becomes one building in a world, and the world is what you unlock by fighting.

The three pillars of the original vision — the endless deterministic world, AI-authored generators, living NPC AI — still stand and are documented in `ROADMAP.md` under *Parked: the open world*. They are not being worked on until the arena has an audience.

## Scale posture

- **Today:** friends in one room, one Node process, one SQLite file, one relay.
- **Arena target:** thousands of concurrent fights. Each fight is host-authoritative and independent, so the relay shards trivially by room; the server only pays out results and serves the catalogue.
- **Trust:** host-authoritative is fine for friends and for the first public beta. Ranked matchmaking needs server-verified outcomes; the deterministic battle kernel (`sim/battle.js`) is the planned path to replaying a fight server-side and checking the result, not to simulating it live.

## Business model

Free on the web, phone-first. The paid pillar is the career — cosmetics, uniques, a seasonal pass — never power. Hard "no" on pay-to-win, loot boxes and energy timers (see `ROADMAP.md` → *We Will NOT Do*). Steam and the app stores follow once the web loop retains.

---
*Grounded technical state and the reading path for the codebase: `CTO_BRIEF.md`. Arena mechanics, careers and network model: `ARENA.md`. The look: `CHARACTERS.md`. Milestones and the parked world systems: `ROADMAP.md`.*
