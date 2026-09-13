# tools/realmesh — the scanned-figure pipeline (experiment, parked)

Everything here ran from a scratch folder during the 2026-09-12 character experiment (see `CHARACTER_EXPERIMENTS.md`
at the repo root). Paths inside the scripts assume: `models/<name>/scene.gltf` next to them (the decimated Sketchfab
downloads), `models/rigs/<rig>.json`, and `sets/*.json`. Node ≥ 18; `decimate.js` needs the `meshoptimizer` npm package
(0.18 was used) resolvable from `/Users/vic/Documents/GitHub/node_modules`.

| file | what it does |
| --- | --- |
| `decimate.js <dir> <tris> [suffix]` | merges a Sketchfab glTF's chunks and simplifies with meshoptimizer; `LOCK=1` keeps UV seams (needed for clean cuts), `ERR=` error budget; writes `<dir><suffix>/scene.gltf` |
| `analyze.js <dir>` / `joints.js <rig>` | height-band statistics and k-means joint guesses to draft a `rigs/<rig>.json` |
| `lum.py <dir>` | per-triangle texture luminance (`tri-lum.bin`) used to tell cloth from steel |
| `skin.js` | the runtime module (`real-skin.js` in the game): normalise, two-bone weights from joint segments, cape chain weights, tint flags, sword extraction, and `fitToRig` (warp the whole scan onto the plastic rig's joints) |
| `pieces.js <set.json> <out>` | cuts a scan into per-pivot armour pieces (`assets/armor/<set>/pieces.json+bin`) — the approach that read as torn paper |
| `rigview.html`, `piecesview.html`, `view.html` | standalone viewers (serve this folder statically; `mini-gltf.js` is a tiny glTF reader for three r128) |
| `rigs/*.json` | joint specs for knight / centurion / hoplite in the normalised scan frame (height 1, facing +Z, right = −X) |
| `sets/*.json` | the plate and legion cut specs |

The decimated models the game uses live in `assets/rigs/<name>/` (12k-triangle `scene.gltf`, `lo.gltf` for big fights,
1K texture, `rig.json`). The original downloads were `~/Desktop/fantasy_knight.zip`, `ancient_warrior.zip`,
`ancient_warrior (1).zip` (Sketchfab, author illustros, Tripo AI generations, Sketchfab Standard licence).
