#!/usr/bin/env python3
"""Bake assets/rigs/warrior/helm_corinthian.{json,bin} and its textures from the Corinthian helm (assets/rigs/warrior/src/
Helmet_of_Leonidas.usdz — "Helmet of Leonidas", two meshes: the helm and its crest, one PBR texture set). The helm is FITTED over
the warrior's head in the bind pose (model units; the face looks +z, the skull's centre at (0, 1.69, -0.005), its crown at 1.828,
the eyes at y ~1.69) by FIT below — a uniform scale and an offset — and written out ready to ride the head bone: positions, normals
and uvs as float32, indices as uint16, one draw group per part. game.js loads it with the warrior (loadHelmModel) for the
'corinthian' helm ware: the sculpted sallet comes off and this goes on. The textures are the model's own, halved to 512.
Run from the repo root: python3 tools/realmesh/helm_corinthian.py   (needs usd-core and Pillow: pip install usd-core Pillow)"""
import json, struct, os, sys, zipfile, tempfile
from pxr import Usd, UsdGeom, Gf
from PIL import Image
base = 'assets/rigs/warrior/'; src = base + 'src/Helmet_of_Leonidas.usdz'; out = base + 'helm_corinthian'
FIT = { 's': 0.001442, 'tx': 0.00326, 'ty': 1.4768, 'tz': -0.00407, 'pitch': 12.0 }   # scale and offset from the model's world units to the head's bind pose, then a PITCH (degrees, about the skull's centre: positive tips the brow up and the nape down) — checked by eye: the eyes in the eye holes, the nasal a hair off the nose, the crown clear of the skull, the neck guard over the nape
PIVOT = (0.0, 1.69, -0.005)   # the skull's centre (game.js LOOK_SKULL)
import math
def place(p):   # model world → the bind pose: scale, offset, then the pitch about the pivot
    x, y, z = p[0] * FIT['s'] + FIT['tx'], p[1] * FIT['s'] + FIT['ty'], p[2] * FIT['s'] + FIT['tz']
    a = math.radians(FIT['pitch']); dy, dz = y - PIVOT[1], z - PIVOT[2]
    return [x, PIVOT[1] + dy * math.cos(a) + dz * math.sin(a), PIVOT[2] - dy * math.sin(a) + dz * math.cos(a)]
def turn(n):    # a direction: the pitch alone
    a = math.radians(FIT['pitch']); return [n[0], n[1] * math.cos(a) + n[2] * math.sin(a), -n[1] * math.sin(a) + n[2] * math.cos(a)]
TEX = { 'color': 'lambert1_baseColor.jpg', 'normal': 'lambert1_normal.jpg', 'rough': 'lambert1_metallicRoughness_rough.jpg', 'occl': 'lambert1_metallicRoughness_occl.jpg' }   # (the metallic map is a 1x1 white: metalness 1, set in game.js)
tmp = tempfile.mkdtemp(); zipfile.ZipFile(src).extractall(tmp)
st = Usd.Stage.Open(os.path.join(tmp, 'scene.usdc'))
P, N, UV, I, parts = [], [], [], [], []
for prim in st.Traverse():
    if not prim.IsA(UsdGeom.Mesh): continue
    m = UsdGeom.Mesh(prim); xf = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
    pts = m.GetPointsAttr().Get(); idx = list(m.GetFaceVertexIndicesAttr().Get()); cnt = list(m.GetFaceVertexCountsAttr().Get())
    assert all(c == 3 for c in cnt), 'triangles only'
    uv = UsdGeom.PrimvarsAPI(prim).GetPrimvar('st0').Get(); nm = m.GetNormalsAttr().Get(); assert len(uv) == len(pts) == len(nm)
    name = prim.GetPath().pathString.split('/')[-3].replace('_Low', '').lower()   # helmet, upper_piece
    v0 = len(P) // 3; t0 = len(I) // 3
    for p, n, t in zip(pts, nm, uv):
        w = xf.Transform(Gf.Vec3d(p)); P += place(w)
        nw = xf.TransformDir(Gf.Vec3d(n)); l = nw.GetLength() or 1; N += turn([nw[0] / l, nw[1] / l, nw[2] / l]); UV += [t[0], t[1]]
    I += [i + v0 for i in idx]; parts.append({ 'name': 'crest' if 'upper' in name else 'helm', 'start': t0, 'count': len(idx) // 3 })
nv, nt = len(P) // 3, len(I) // 3; assert nv < 65536
mn = [min(P[i::3]) for i in range(3)]; mx = [max(P[i::3]) for i in range(3)]
bin = struct.pack('<%df' % len(P), *P) + struct.pack('<%df' % len(N), *N) + struct.pack('<%df' % len(UV), *UV) + struct.pack('<%dH' % len(I), *I)
open(out + '.bin', 'wb').write(bin)
hdr = { 'src': os.path.basename(src), 'fit': FIT, 'verts': nv, 'tris': nt, 'parts': parts, 'bounds': { 'min': mn, 'max': mx },
        'layout': 'position f32x3, normal f32x3, uv f32x2 (origin bottom-left), index u16x3 — in that order, no padding', 'metalness': 1.0, 'textures': {} }
for k, f in TEX.items():
    im = Image.open(os.path.join(tmp, '0', f)); im.thumbnail((512, 512)); fn = 'helm_corinthian_%s.jpg' % k; im.save(base + fn, quality=88); hdr['textures'][k] = fn
json.dump(hdr, open(out + '.json', 'w'), indent=1)
print('wrote', out + '.bin', len(bin), 'bytes;', nv, 'verts', nt, 'tris', parts, 'bounds', [round(v, 3) for v in mn], [round(v, 3) for v in mx])
