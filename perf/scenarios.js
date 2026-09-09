// Perf scenarios — each maps to one of the six performance goals.
// The BODY of each scenario runs INSIDE the page (serialized to the browser), so it may
// only use browser globals + the BV.* hooks. It returns a flat metrics object; the runner
// diffs those against perf/budgets.json.
//
// Metric conventions:
//   drawCalls / triangles / geometries  — from BV.perf(), the render counters. Resolution- and
//                                          GPU-independent, so they're the trustworthy proxy for
//                                          device FPS (fewer draws/tris = faster on an iPhone 13).
//   simMsPerFrame                        — pure CPU sim cost, timed via BV.advance*/performance.now,
//                                          isolated from the (software-GL) render. This is the hitch signal.
//   switchMs                             — wall time of a mode/detail-tier transition (the rebuild cost).
//
// `tier` forces a quality tier before measuring. We default to 'low' because that's what phones run,
// so 'low' numbers are the ones that decide whether the game ships to an iPhone 13.

const SCENARIOS = [
  {
    key: 'boot-map',
    goal: '#1 device FPS — the world you spawn into',
    tier: 'low',
    // Fresh universe, strategic overworld as dealt. Characterises the default draw-call load.
    body: `
      BV.bootUniverse(1337);
      BV.setQuality('low');
      BV.settle();
      __render(); __render();
      const p = BV.perf();
      return { drawCalls: p.drawCalls, triangles: p.triangles, geometries: p.geometries, fighters: BV.perfSample().fighters };
    `,
  },
  {
    key: 'map-overview-rung0',
    goal: '#4 far things not rendered — the zoomed-out chart',
    tier: 'low',
    // Discovery/overview zoom. Far terrain should collapse to icons; draw calls must stay BOUNDED
    // even though a huge area is "visible" — that's the culling guarantee.
    body: `
      BV.bootUniverse(1337);
      BV.enterMap(); BV.zoom(0.95); // zoom the ONE view all the way out to the chart/icon overview (tier 0)
      BV.setQuality('low');
      BV.advanceMap(0.2); BV.settle();
      __render(); __render();
      const p = BV.perf();
      return { drawCalls: p.drawCalls, triangles: p.triangles, geometries: p.geometries };
    `,
  },
  {
    key: 'action-street-rung2',
    goal: '#5/#6 close=low-poly, very-close=detailed — on-foot street tier',
    tier: 'low',
    // On-foot roam (rung 2). The detail bubble should raise poly count only right around the hero
    // (#6) while everything past ~100u stays coarse (#5). We record the bubble state so a regression
    // that DISABLES the LOD (tris collapse) or BLOWS IT UP (tris explode) both trip the budget.
    // NOTE: since the one-view zoom model, the detail tier follows fieldZoomT alone — BV.fieldMode(true)
    // at the resting zoom (t=0) is a half-state the game never enters (enterMap parks t at 0). Drive the
    // ZOOM axis instead, like the player: past Z_LOCK it flips field mode AND lands in the street tier.
    body: `
      BV.bootUniverse(1337);
      BV.enterMap(); BV.zoom(-0.4);   // zoom in past Z_LOCK — the one-view way onto the street rung (FIELD_COMBAT_ZOOM)
      BV.setQuality('low');
      BV.advanceMap(0.3); BV.settle();
      __render(); __render();
      const p = BV.perf(); const d = BV.detailTier();
      return { drawCalls: p.drawCalls, triangles: p.triangles, geometries: p.geometries,
               fineTiles: d.fineTiles, hyperTiles: d.hyperTiles, streets: d.streets };
    `,
  },
  {
    key: 'action-battle-200',
    goal: '#1 device FPS — a 200-fighter melee on foot',
    tier: 'low',
    // Conjure a host and fight it in place. Reports both the render load AND the pure-CPU sim cost
    // per frame over 2s of deterministic stepping — the number that decides if a phone holds framerate
    // when the swords come out.
    body: `
      BV.bootUniverse(1337);
      BV.enterBattleWith(200);
      BV.setQuality('low');
      BV.settle();
      __render(); __render();
      const p = BV.perf();
      const t0 = performance.now();
      const steps = 125; // ~2s at dt=0.016
      BV.advance(steps * 0.016, 0.016);
      const simMs = (performance.now() - t0);
      return { drawCalls: p.drawCalls, triangles: p.triangles, geometries: p.geometries,
               fighters: BV.perfSample().fighters, simMsPerFrame: +(simMs / steps).toFixed(3) };
    `,
  },
  {
    key: 'sim-map-offmap',
    goal: '#2 smooth generation — the living map ticking',
    tier: 'low',
    // 3s of deterministic overworld sim (off-map wars, band movement, chunk streaming as the world
    // ticks). Pure CPU cost per frame — a spike here is a hitch a player feels while riding.
    body: `
      BV.bootUniverse(1337);
      BV.enterMap();
      BV.setQuality('low');
      const t0 = performance.now();
      const steps = 60; // 3s at dt=0.05
      BV.advanceMap(steps * 0.05, 0.05);
      const simMs = (performance.now() - t0);
      return { simMsPerFrame: +(simMs / steps).toFixed(3) };
    `,
  },
  {
    key: 'mode-switch',
    goal: '#3 no perf drop across mode changes',
    tier: 'low',
    // Time the detail-tier rebuilds: strategic -> street -> battle -> back. Each transition rebuilds
    // terrain tessellation / settlements / roads, and a fat rebuild is a visible stall on a switch.
    body: `
      BV.bootUniverse(1337);
      BV.setQuality('low');
      BV.enterMap(); BV.advanceMap(0.1);
      const timed = (fn) => { const t = performance.now(); fn(); return +(performance.now() - t).toFixed(2); };
      // one-view zoom model: transitions are ZOOM crossings (they flip field mode + detail tier together)
      const toStreet = timed(() => { BV.zoom(-0.4); BV.advanceMap(0.05); });
      const toStrat  = timed(() => { BV.zoom(0); BV.advanceMap(0.05); });
      const toBattle = timed(() => { BV.enterBattleWith(60); BV.advance(0.05, 0.016); });
      return { switchToStreetMs: toStreet, switchToStrategicMs: toStrat, switchToBattleMs: toBattle };
    `,
  },
];

module.exports = { SCENARIOS };
