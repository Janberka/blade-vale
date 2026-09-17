# the base body's pieces entry (head / hair / beard / brow / socket / eye + the body parts) from the painted texture and the
# vertex positions, and the atlas normalised for the game's tints: every skin pixel scaled so the mean skin is the palette's
# skin cell (#ffdcb4 — lookApply divides the tone by it), the painted hair and beard flattened to skin so the look's hair colour paints them
import json, struct, sys, math
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1] if len(sys.argv) > 1 else 'view/models/base/'
g = json.load(open(out + 'scene.gltf')); bb = open(out + 'scene.bin', 'rb').read()
FMT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]; f = FMT[a['componentType']]
    return struct.unpack_from('<%d%s' % (a['count'] * n, f), bb, bv.get('byteOffset', 0) + a.get('byteOffset', 0))
node = [n for n in g['nodes'] if n.get('mesh') is not None and n['name'] == 'base_body'][0]; p = g['meshes'][node['mesh']]['primitives'][0]
pos = acc(p['attributes']['POSITION']); uv = acc(p['attributes']['TEXCOORD_0']); idx = acc(p['indices']); nv = len(pos) // 3
parts = json.load(open(out + 'parts.json')); pcls = [parts['classes'][c] for c in parts['vclass']]
A = Image.open(out + 'atlas_raw.jpg').convert('RGB'); W, H = A.size; px = A.load()
col = [px[min(W - 1, int(uv[v*2] * W)), min(H - 1, int(uv[v*2+1] * H))] for v in range(nv)]
lum = [(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 for c in col]
# the skin's mean: body and head vertices that are not obviously hair (the darkest third of the head is hair/beard/shadow)
skinL = sorted(lum[v] for v in range(nv) if pcls[v] != 'eye'); medL = skinL[len(skinL) // 2]
EYE = [(0.034, 1.972, 0.128), (-0.034, 1.972, 0.128)]
def classify(v):
    x, y, z = pos[v*3:v*3+3]; c = pcls[v]
    if c == 'eye': return 'eye'
    if c != 'head': return c
    if min(math.hypot(x - e[0], y - e[1], z - e[2]) for e in EYE) < 0.032: return 'socket'
    if 1.985 <= y <= 2.012 and z > 0.085 and 0.012 <= abs(x) <= 0.072: return 'brow'
    dark = lum[v] < medL * 0.72
    if dark and (y > 1.965 or z < -0.04) and y > 1.80: return 'hair'          # the crop: dark paint above the eyes or round the back
    lip = abs(x) < 0.03 and 1.885 < y < 1.935 and z > 0.14
    if not lip and 1.77 < y and (y < 1.935 or (y < 1.96 and abs(x) > 0.055)) and z > -0.03: return 'beard'   # the jaw, the chin, the cheeks up to the sideburns (the look cuts the styles out of it)
    return 'head'
vc = [classify(v) for v in range(nv)]
# smooth: a head vertex whose neighbours are mostly hair/beard joins them (and the other way round), by welded position
key = {}; wid = [0] * nv
for v in range(nv):
    k = '%.4f,%.4f,%.4f' % pos[v*3:v*3+3]; wid[v] = key.setdefault(k, v)
nbr = {}
for t in range(0, len(idx), 3):
    a, b, c = [wid[idx[t + k]] for k in range(3)]
    for u, w in ((a, b), (b, c), (c, a)): nbr.setdefault(u, set()).add(w); nbr.setdefault(w, set()).add(u)
for it in range(2):
    new = list(vc)
    for v in range(nv):
        if vc[v] not in ('head', 'hair', 'beard'): continue
        ns = [vc[wid[n]] for n in nbr.get(wid[v], ())]
        if not ns: continue
        for cl in ('hair', 'beard'):
            if vc[v] == 'head' and sum(1 for n in ns if n == cl) > len(ns) * 0.6: new[v] = cl
        if vc[v] in ('hair', 'beard') and sum(1 for n in ns if n == 'head') > len(ns) * 0.75: new[v] = 'head'
    vc = new
for v in range(nv):   # every copy of a position agrees
    vc[v] = vc[wid[v]]
classes = ['head', 'hair', 'beard', 'brow', 'socket', 'eye', 'torso', 'armL', 'armR', 'foreL', 'foreR', 'handL', 'handR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR']
for c in vc:
    if c not in classes: classes.append(c)
vclass = [classes.index(c) for c in vc]
tri = []
for t in range(0, len(idx), 3):
    cs = [vclass[idx[t + k]] for k in range(3)]
    tri.append(max(set(cs), key=cs.count) if cs.count(max(set(cs), key=cs.count)) >= 2 else cs[0])
counts = {c: vc.count(c) for c in classes}; print('classes', counts)
pieces = json.load(open(out + 'pieces.json')) if __import__('os').path.exists(out + 'pieces.json') else {}
pieces['body'] = {'classes': classes, 'tri': tri, 'mats': ['skin', 'eye'], 'vmat': [1 if c == 'eye' else 0 for c in vc], 'vclass': vclass, 'sculpted': True}
json.dump(pieces, open(out + 'pieces.json', 'w'))
# ---- the atlas for the game: skin normalised to the palette's skin cell, hair and beard flattened to skin ----
TARGET = (255, 220, 180)
skinCols = [col[v] for v in range(nv) if vc[v] not in ('eye', 'hair', 'beard', 'brow', 'socket')]
mean = [sum(c[k] for c in skinCols) / len(skinCols) for k in range(3)]
# the gain puts the BRIGHT skin (the 92nd percentile) at the palette cell, so the highlights keep their shape instead of clipping; the mean lands ~0.8 of it (game.js lifts a sculpted body's tint back)
p92 = [sorted(c[k] for c in skinCols)[int(len(skinCols) * 0.92)] for k in range(3)]; gain = [TARGET[k] / p92[k] for k in range(3)]
print('skin mean', [round(m) for m in mean], 'p92', p92, 'gain', [round(x, 3) for x in gain], 'mean after', [round(mean[k] * gain[k]) for k in range(3)])
mask = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(mask)
for t in range(0, len(idx), 3):
    if classes[tri[t // 3]] != 'hair': continue
    dr.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
mask = mask.filter(ImageFilter.MaxFilter(5))
N = A.copy(); npx = N.load(); mpx = mask.load()
for y in range(H):
    for x in range(W):
        if x >= 1024 and y >= 1024: continue                  # (the free quadrant)
        if x < 256 and y >= 1024: continue                    # (the eyes keep their paint)
        r, gg, b = px[x, y]
        if mpx[x, y]:
            l = (0.299 * r + 0.587 * gg + 0.114 * b) / 255; f = 0.86 + 0.28 * min(1.0, l / max(0.05, medL))   # a little of the strands' shading, on skin
            npx[x, y] = tuple(min(255, int(TARGET[k] * f)) for k in range(3))
        else:
            npx[x, y] = (min(255, int(r * gain[0])), min(255, int(gg * gain[1])), min(255, int(b * gain[2])))
N.save(out + 'atlas.jpg', quality=88); mask.save(out + 'hair_mask.png')
print('atlas normalised; hair/beard mask px', sum(1 for y in range(0, H, 4) for x in range(0, W, 4) if mpx[x, y]) * 16)
