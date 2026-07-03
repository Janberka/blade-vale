# The optimization loop (drive with `/loop`)

Run this as a recurring, self-paced task while you work:

```
/loop node perf/run.js --json
```

Each iteration, the loop should:

1. **Run the harness.** `npm run perf` (check vs budgets) or `node perf/run.js --json` (raw metrics).
2. **If green:** report one terse line ("perf green — draws/tris/sim within budget") and stop until next tick.
   Occasionally propose a *new* scenario for a code path not yet covered (see `perf/README.md` → "Adding a scenario").
3. **If a budget regressed:**
   - **Confirm it's real** — re-run once; software-GL timing has jitter, counters do not. Trust counter
     regressions (drawCalls/triangles/geometries) immediately; treat `*Ms` regressions as real only if
     they repeat.
   - **Localise it** — `git log`/`git diff` since the last green run; the metric that moved points at the
     system (draws→settlements/scatter, triangles→LOD/tessellation, simMs→battle or map sim, switchMs→
     `applyDetailTier`).
   - **Fix or flag** — apply the optimization if it's clear (e.g. a mesh that should be instanced/merged,
     an LOD that stopped culling, a per-frame allocation), then re-run to prove the budget is green again.
     If it's a deliberate cost, bump the baseline with `node perf/run.js --update` and say why.
4. **Never** treat the headless FPS number as real device FPS — see README. Only counters + sim-ms are trustworthy here.

## Standing perf targets (the "what needs to be fast")

- **#1** Ships to iPhone 13 / old MacBook → keep `low`-tier draw calls + `simMsPerFrame` down; the fewer
  draws/tris, the more headroom on real silicon.
- **#2** Generation is smooth → `sim-map-offmap.simMsPerFrame` has no spikes; watch main-thread chunk/scatter
  build (there are **no web workers** yet — a candidate future optimization).
- **#3** No drop across mode changes → `mode-switch.*Ms` stays low (the `applyDetailTier` rebuild cost).
- **#4** Far not rendered → `map-overview-rung0` draw calls stay BOUNDED at overview zoom.
- **#5/#6** LOD correctness → `action-street-rung2` keeps `fineTiles`/`streets` > 0 (bubble engages) while
  total triangles stay under budget (coarse past the bubble).
