#!/usr/bin/env python3
"""Bake assets/rigs/warrior/pieces.json: which armour piece every triangle of the warrior's armour mesh belongs to
(helmet, pauldron, sleeve, elbow, vambrace, cuirass, skirt, straps, knee, greaves, pouch), what the palette says each
vertex is made of (steel / cloth / leather / dark / skin), and the head's hair and beard regions on the body mesh.
game.js reads it to dress every fighter differently: pieces are dropped per look and painted by vertex colour.
Run from the repo root: python3 tools/realmesh/warrior_pieces.py   (needs Pillow)"""
import json, struct, os, sys
from PIL import Image
base = 'assets/rigs/warrior/'
g = json.load(open(base + 'scene.gltf')); bin = open(base + g['buffers'][0]['uri'], 'rb').read()
FMT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]; f = FMT[a['componentType']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); cnt = a['count'] * n
    return struct.unpack_from('<%d%s' % (cnt, f), bin, off)
names = [n.get('name') for n in g['nodes']]
im = Image.open(base + g['images'][0]['uri']).convert('RGB'); W, H = im.size
def mat_of(u, v):
    x = min(W - 1, max(0, int(u * W))); y = min(H - 1, max(0, int(v * H))); r, gg, b = [c / 255 for c in im.getpixel((x, y))]
    mx, mn = max(r, gg, b), min(r, gg, b); sat = mx - mn
    if sat < 0.12: return 'steel' if mx > 0.45 else 'dark'
    if b > r and b > gg: return 'cloth'
    if r > 0.8 and gg > 0.6 and b > 0.45: return 'skin'
    if r > gg > b: return 'leather'
    return 'other'
out = {}
for node in g['nodes']:
    if node.get('mesh') is None: continue
    p = g['meshes'][node['mesh']]['primitives'][0]; sk = g['skins'][node['skin']]
    short = node['name'].replace('FantasyWarrior_', '').replace('_6_characters_0', '')
    pos = acc(p['attributes']['POSITION']); uv = acc(p['attributes']['TEXCOORD_0']); ji = acc(p['attributes']['JOINTS_0']); w = acc(p['attributes']['WEIGHTS_0']); idx = acc(p['indices'])
    nv = len(pos) // 3
    # weld by position, then connected components over the triangles
    key = {}; vid = [0] * nv
    for v in range(nv):
        k = '%.3f,%.3f,%.3f' % pos[v * 3:v * 3 + 3]; vid[v] = key.setdefault(k, v)
    par = list(range(nv))
    def f(x):
        while par[x] != x: par[x] = par[par[x]]; x = par[x]
        return x
    def u(a, b):
        a, b = f(a), f(b)
        if a != b: par[a] = b
    for t in range(0, len(idx), 3): u(vid[idx[t]], vid[idx[t + 1]]); u(vid[idx[t + 1]], vid[idx[t + 2]])
    comps = {}
    for v in range(nv): comps.setdefault(f(vid[v]), []).append(v)
    vmat = [mat_of(uv[v * 2], uv[v * 2 + 1]) for v in range(nv)]
    vclass = [''] * nv
    for vs in comps.values():
        mn = [9, 9, 9]; mx = [-9, -9, -9]; jc = {}
        for v in vs:
            for a in range(3): mn[a] = min(mn[a], pos[v * 3 + a]); mx[a] = max(mx[a], pos[v * 3 + a])
            best = max(range(4), key=lambda k: w[v * 4 + k]); jn = names[sk['joints'][ji[v * 4 + best]]]; jc[jn] = jc.get(jn, 0) + 1
        top = max(jc, key=jc.get); n = len(vs); cy = (mn[1] + mx[1]) / 2; cz = (mn[2] + mx[2]) / 2
        if short == 'armor':
            if top == 'n12': c = 'helmet'                                   # the sallet and its ear discs
            elif n > 1500: c = 'cuirass'
            elif n > 1000: c = 'skirt'
            elif n > 700: c = 'vambrace'
            elif n > 300 and mx[1] < 0.5: c = 'greaves'
            elif 200 < n < 300 and cy < 1.0: c = 'cuirass'                  # the fauld band under the breastplate
            elif 180 < n < 220 and cy > 1.3: c = 'pauldron'
            elif n == 160: c = 'sleeve'                                     # the cloth upper arm
            elif n == 150: c = 'elbow'
            elif cz < -0.08 and 0.85 < cy < 1.06 and n > 100: c = 'pouch'   # the pouches on the back of the belt
            elif n == 128: c = 'skirt'                                      # the hip plates
            elif top in ('n75', 'n76', 'n77', 'n78'): c = 'straps'          # the hanging leather straps
            elif n == 68 and mx[1] < 0.1: c = 'boot'                        # the soles: leather under breeches or fur
            elif 1.4 < cy < 1.5 and n < 50: c = 'pauldron'                  # the buckles that hold them
            elif n == 46 and cy < 0.6: c = 'knee'
            else: c = 'cuirass'                                             # chest buckle and back strap
        elif short == 'body': c = 'eye' if (top == 'n12' and n < 400) else ('head' if top == 'n12' else 'hand')
        else: c = short
        for v in vs: vclass[v] = c
    if short == 'armor':                                                    # the cuirass component carries the cloth too: upper-arm sleeves and the skirt's front
        for v in range(nv):
            if vclass[v] == 'cuirass' and vmat[v] == 'cloth': vclass[v] = 'sleeve' if pos[v * 3 + 1] > 1.15 else 'skirt'
    if short == 'body':                                                     # hair and beard: regions of the bald head (bind pose, model units)
        for v in range(nv):
            if vclass[v] != 'head': continue
            x, y, z = pos[v * 3:v * 3 + 3]
            face = z > 0.045 and y < 1.775                                  # the forehead and face stay skin
            if (y > 1.725 and not face) or (z < -0.03 and y > 1.60) or (abs(x) > 0.085 and y > 1.69 and not face): vclass[v] = 'hair'
            elif 1.705 < y < 1.74 and z > 0.085 and abs(x) < 0.095: vclass[v] = 'brow'                                    # the brow ridge over the eyes
            elif 1.47 < y < 1.615 and z > -0.03 and abs(x) < 0.115: vclass[v] = 'beard'                                   # jaw, chin, lips: a full beard
            elif 1.615 <= y < 1.665 and abs(x) > 0.075 and z > 0.0: vclass[v] = 'beard'                                   # sideburns up the cheek
            elif 1.655 < y < 1.705 and z > 0.07 and 0.025 < abs(x) < 0.1: vclass[v] = 'socket'                            # round the eyes
            elif z > 0.06 and 0.03 < abs(x) < 0.095 and abs((y - 1.665) + 0.9 * (abs(x) - 0.06)) < 0.014: vclass[v] = 'scarL' if x < 0 else 'scarR'   # a cut across one cheek
    classes = sorted(set(vclass)); mats = sorted(set(vmat))
    tri = []
    for t in range(0, len(idx), 3):
        a, b, c = vclass[idx[t]], vclass[idx[t + 1]], vclass[idx[t + 2]]; tri.append(classes.index(a if a == b else (b if b == c else a)))
    out[short] = {'classes': classes, 'tri': tri, 'mats': mats, 'vmat': [mats.index(m) for m in vmat], 'vclass': [classes.index(c) for c in vclass]}
    print(short, {c: vclass.count(c) for c in classes}, {m: vmat.count(m) for m in mats})
json.dump(out, open(base + 'pieces.json', 'w'), separators=(',', ':'))
print('wrote', base + 'pieces.json', os.path.getsize(base + 'pieces.json'), 'bytes')
