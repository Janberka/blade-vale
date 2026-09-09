# Perf harness

A headless, deterministic performance guard for the game. It drives the real client through
canonical scenarios via the `BV.*` hooks and checks stable proxy metrics against committed budgets.

## What it measures (and what it deliberately doesn't)

Headless Chrome renders via **software GL** — a single 977k-triangle frame takes ~15s, so on-screen
FPS here is *meaningless*. Real iPhone-13 / old-MacBook FPS is a **manual device check**, not something
a cloud/headless run can produce.

What it *can* guard, reliably and every run, are the **causes** of bad device FPS:

| Metric | Source | Why it's trustworthy |
| --- | --- | --- |
| `drawCalls`, `triangles`, `geometries` | `BV.perf()` render counters | Resolution- and GPU-independent. Fewer = faster on every device. |
| `simMsPerFrame` | `BV.advance*` timed with `performance.now` | Pure CPU sim cost, **no render** — the hitch signal (#2, #3). |
| `switch*Ms` | wall time of a detail-tier transition | The rebuild stall you feel on a mode change (#3). |
| `fineTiles`, `streets`, `fighters` | `BV.detailTier()` etc. | Floor-checked: if they drop to 0 the LOD/detail system silently stopped engaging (#5, #6). |

## Scenarios → the six goals

- `boot-map`, `action-battle-200` → **#1** device FPS (draw/tri load + sim cost, at `low` = phone tier)
- `sim-map-offmap` → **#2** smooth generation (per-frame sim cost while the map ticks)
- `mode-switch` → **#3** no perf drop across map↔action↔battle
- `map-overview-rung0` → **#4** far things stay bounded (culling)
- `action-street-rung2` → **#5/#6** coarse past the bubble, detailed right around the hero

## Usage

```sh
node perf/run.js --update   # capture baselines — run on a known-good commit
node perf/run.js            # check current tree vs budgets; exits 1 on regression
node perf/run.js --json     # raw metrics as JSON (what the /loop agent reads)
```

Budgets live in `perf/budgets.json` and are committed. A metric regresses if it exceeds
`baseline * 1.15` (15% headroom + 1ms timing slack). Bump the baseline intentionally with `--update`
when a change legitimately costs more.

## The optimization loop

`/loop node perf/run.js` (or the wording in `perf/LOOP.md`) re-runs the harness as you work and
reports regressions. When something regresses, the loop's job is to (a) confirm it's real, (b) find the
commit/edit that caused it, and (c) propose or apply a fix — then re-run to prove the budget is green.

## Adding a scenario

Append to `perf/scenarios.js`. The `body` runs **inside the page** — it may use browser globals,
`BV.*`, and the injected `__render()` (forces one draw so the counters refresh). Return a flat object
of metrics; anything matching `drawCalls|triangles|geometries|*Ms|*MsPerFrame` is auto-budgeted as
"lower is better". Then `node perf/run.js --update` to record its baseline.

## Real-device FPS (out of scope here, on the roadmap)

The `?debug=1` overlay (top-left: fps / frame ms / draws / tris / tier / mode) is the on-device readout.
Load the game on an actual iPhone 13 / old MacBook with `?debug=1` to see true FPS. Wiring those numbers
back automatically is the "add a real-device path" option, not built yet.
