# Engineering Update — Blade Vale

**Date:** 2026-07-05  ·  **From:** Engineering  ·  **For:** CEO, CTO
**Cycle:** the three commits landed today on `main` (`02615c3`, `bd041d0`, `cfe8774`)

---

## TL;DR

This cycle pushed on all three pillars at once and simplified the single control
model that testers kept tripping over.

- **Endless world got *coherent*.** The frontier beyond the five heartland powers
  no longer reads as salt-and-pepper "free cities." It now condenses into infinite,
  deterministic, named-and-coloured **realms** with contiguous borders — same math
  on client and server, so a nation looks identical wherever it's first generated.
- **The living world got *legible*.** Garrisons now patrol the *whole realm they
  hold* — riding out to guard their villages and castles, turning neutral columns
  back at the border without bloodshed — instead of grinding one ring at the city
  wall. And we shipped an admin god's-eye map so we can actually *watch* the world
  run.
- **The game got *one control*.** We deleted the discrete "strategic map vs. action"
  mode split. There is now a single continuous zoom: pull out to command your army
  and click-to-march, push in to lead on foot and fight. One axis, one mental model.
- **It's installable.** Blade Vale is now a home-screen PWA that launches
  chrome-free in landscape on iOS and Android.

Nothing here changes the roadmap phase gates; it advances work already inside them.

---

## For the CEO — outcomes & narrative

**The pitch is more true today than yesterday.** Our story is "the real endless
world." The weakest part of that claim was that once you rode past the five named
kingdoms, the world thinned into anonymous one-off towns. As of this cycle the
frontier *keeps having politics*: every region is a real nation with a name, a
banner colour, and borders that touch its neighbours' — generated on the fly,
forever, and identical for every player. That is the pillar demoing itself.

**The world now visibly governs itself.** A tester riding the map sees garrisons
leave their capital to guard outlying holds, and sees a foreign column get shadowed
and waved off friendly soil rather than everyone instantly fighting. That "this
place is alive and has rules" read is exactly the living-NPC-AI pillar, and it's
now something you can point a camera at.

**Lower friction to first fun.** The old two-mode control scheme (strategic map,
then a separate on-foot action mode you toggled into) was the single most common
point of confusion. Collapsing it to one zoom — *out to command, in to fight* —
removes a concept new players had to learn before anything felt good.

**Distribution unlocked.** The install-to-home-screen PWA means we can hand a
tester a link and they get a full-screen, landscape, app-like experience with no
app-store gate. This is the cheapest possible mobile distribution and it works now.

**Funding context:** funded 2026-07-04, actively hiring a founding CTO + engineer.
This update is the kind of week the CTO hire is joining into.

---

## For the CTO — technical detail

### 1. Emergent frontier realms — `sim/world-sim.js`, `server/warfare.js`
A new realm kernel carves the world beyond the heartland into
`REALM_BLOCK×REALM_BLOCK` chunk cells. Each non-wilderness cell is one realm grown
from a region seed: `realmFor(cx, cz, worldSeed)` → deterministic name, seeded HSL
banner colour, and a nominal capital seat. `settlementOwner` now assigns a whole
cell to its realm; wilderness cells stay masterless "Free Cities." The kernel is
shared code, so client render and server authority agree byte-for-byte.
Warfare consequence: **Free City is now the only masterless owner** — nations *and*
emergent realms both keep a full garrison (previously frontier holds got only a
militia watch).

### 2. Patrols that walk their realm — `server/warfare.js` + migration `014_patrol_focus.sql`
Patrols gained a roaming **focus** (`focus_x/z/key/until` columns) the server
re-picks over time: mostly their home city's borders, occasionally a sortie to a
nearby owned village or castle they also guard — with a per-hold visitor cap so a
small hold can't end up better-garrisoned than the city that raised the watch. The
patrol ring now wraps *outside* the ramparts (`ring = footprint + leash`) instead
of orbiting the market square. Threat logic on owned soil is now three-way:
declared **enemies** are run down; **neutral** peer columns are shadowed and nudged
back toward the border with no combat; **friends** (same realm / pact) pass freely.

### 3. Admin god's-eye overview — `server/admin.js` (new), `server/index.js`, `admin.html`
`GET /api/v1/admin/overview` serves the *standing* world the admin map never
had — a terrain raster (`groundColorRGB` sampled on a grid, sea for free), the
routed road network as world-space polylines, and the live political border field —
all sampled through the shared `sim/terra.js` kernel so overwatch == game. Terrain
and roads are static-per-universe and cached; territory is rebuilt live as capitals
fall. `admin.html` layers this beneath the existing live entity feed (players +
every army, patrols included). Observing ticks the shared world, same as `/world`.

### 4. One-view zoom control model — `game.js`, `index.html`
The discrete strategic/action mode split is deleted. A single `fieldZoomT`
(`-1..+1`) axis with two hysteresis-guarded thresholds drives everything:
`t ≤ Z_LOCK` → pointer-locked aim/combat at street detail (click = attack);
`Z_LOCK < t ≤ Z_CHART` → free cursor, miniature, click-to-march;
`t > Z_CHART` → free cursor, chart/icon overview. `onZoomChanged` /
`reconcilePointerLock` reconcile pointer-lock, field mode, and detail tier off zoom
alone. `Esc` frees the cursor to march without changing zoom; a zoom-in gesture
re-locks. Also: **man-to-man field melee** — when both hosts of a map-battle are
materialised near the hero, their crowds pair off and trade real
windup→strike→recover swings (the hero's own move set) while the numeric resolver
still decides the outcome and culls the fallen.

### 5. Installable PWA — `manifest.webmanifest` (new), `index.html`
Web-app manifest + iOS/Android meta tags for chrome-free landscape fullscreen from
a home-screen icon, plus a portrait rotate-gate on coarse-pointer devices.

---

## Risks & honest gaps (unchanged from last cycle — still open)

1. **Warfare determinism is not yet test-covered.** The realm kernel and territory
   field are deterministic *by construction* and shared client/server, but we do
   not yet have an automated test that pins server warfare (musters, campaigns,
   patrol focus) to a golden trace. Until we do, a subtle client/server divergence
   could ship unnoticed. This is the first test I'd want the new hire to own.
2. **Single-engine float determinism.** We rely on JS float math matching between
   client render and server authority. It holds today, but there is no guard proving
   it holds across engines/platforms. A cross-platform determinism harness is the
   safety net we're missing.

Both are *known* and *bounded* — they are the honest asterisks on the "byte-identical
world" claim, not surprises.

---

## Next up (proposed)

- **Determinism test harness** for server warfare (closes risk #1) — highest-value
  next investment and a clean first project for the CTO hire.
- **Emergent wars & diplomacy scaling** among the frontier realms — they have
  borders and garrisons now; next they need to *contest* those borders (roaming
  hosts + emergent wars is the pending half of the realms pillar).
- **Onboarding pass on the unified zoom** — now that there's one control, tune the
  just-in-time hint so a first-timer discovers "out to command, in to fight" without
  reading the controls line.

---

*Commits this cycle:*
`cfe8774` one-view zoom + field melee + PWA · `bd041d0` emergent realms + roaming
patrols · `02615c3` admin god's-eye overview.
