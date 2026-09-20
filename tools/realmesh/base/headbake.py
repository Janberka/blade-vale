# the base body's pieces entry (head / hair / beard / brow / socket / eye + the body parts) from the painted texture and the
# vertex positions, and the atlas normalised for the game's tints: every skin pixel scaled so the mean skin is the palette's
# skin cell (#ffdcb4 — lookApply divides the tone by it), the painted hair and beard flattened to skin so the look's hair colour paints them
import json, struct, sys, math
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1] if len(sys.argv) > 1 else 'build/base/'
g = json.load(open(out + 'scene.gltf')); bb = open(out + 'scene.bin', 'rb').read()
FMT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]; f = FMT[a['componentType']]
    return struct.unpack_from('<%d%s' % (a['count'] * n, f), bb, bv.get('byteOffset', 0) + a.get('byteOffset', 0))
node = [n for n in g['nodes'] if n.get('mesh') is not None and n['name'] == 'base_body'][0]; p = g['meshes'][node['mesh']]['primitives'][0]
pos = acc(p['attributes']['POSITION']); uv = acc(p['attributes']['TEXCOORD_0']); idx = acc(p['indices']); nv = len(pos) // 3
parts = json.load(open(out + 'parts.json')); pcls = [parts['classes'][c] for c in parts['vclass']]
raw = out + 'atlas_raw.jpg'
if not __import__('os').path.exists(raw): raw = __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '../../chared/items/atlas_raw.jpg')   # the painted atlas lives with the char editor; assets/ only carries the normalised one players download
A = Image.open(raw).convert('RGB'); W, H = A.size; px = A.load()
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
    if not lip and 1.77 < y and (y < 1.935 or (y < 1.96 and abs(x) > 0.055)) and z > 0.01: return 'beard'   # the jaw, the chin, the cheeks up to the sideburns (the look cuts the styles out of it). The cut used to be z > -0.03, which reached BEHIND the ear: six vertices on the nape took the beard's colour and, spanning long neck slivers, painted a brown patch under the skull (2026-09-20).
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
# THE CROP GROWS INTO THE PAINT (2026-09-20, the user: "a weird brown piece on the neck"). The sculpt's hair does not
# stop where classify() drew it: it runs on down the nape, and those vertices came out `head`. Painted brown but skinned
# in the skin's tint, that tail read as a patch of something stuck to the neck. So the hair class spreads from the crop
# into any neighbour whose own paint is as dark as hair — the tail joins the crop and takes the look's colour with it.
for _ in range(4):
    grow = []
    for v in range(nv):
        if vc[wid[v]] != 'head' or lum[v] >= medL * 0.80: continue
        if any(vc[w] == 'hair' for w in nbr.get(wid[v], ())): grow.append(wid[v])
    if not grow: break
    for w in grow: vc[w] = 'hair'
print('hair grown into the paint:', sum(1 for v in range(nv) if vc[wid[v]] == 'hair'), 'verts')
# ONE CROP, NO SPECKS (2026-09-20): the paint has dark patches away from the hair — a shadow on the nape, a smudge
# behind an ear — and each became its own little island of 'hair'. Harmless while the region was flattened to skin;
# once the look's colour dyes the hair class (game.js LOOK_HAIR_TEX) an island over skin-coloured paint reads as a
# brown blotch on the neck. Only the LARGEST connected run of hair survives; the rest goes back to head.
seen = set(); best = []
for v in range(nv):
    if vc[wid[v]] != 'hair' or wid[v] in seen: continue
    comp = []; stack = [wid[v]]; seen.add(wid[v])
    while stack:
        u = stack.pop(); comp.append(u)
        for w in nbr.get(u, ()):
            if w not in seen and vc[w] == 'hair': seen.add(w); stack.append(w)
    if len(comp) > len(best): best = comp
keep = set(best)
if keep:
    dropped = 0
    for v in range(nv):
        if vc[wid[v]] == 'hair' and wid[v] not in keep: vc[v] = 'head'; dropped += 1
    print('hair islands dropped:', dropped, 'verts; the crop keeps', len(keep))
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
skinRef = [mean[k] * gain[k] for k in range(3)]   # what ordinary skin lands on after the gain — what a repaired pixel must match
print('skin mean', [round(m) for m in mean], 'p92', p92, 'gain', [round(x, 3) for x in gain], 'mean after', [round(mean[k] * gain[k]) for k in range(3)])
# THE CROP'S OWN TEXELS are those of triangles ALL THREE of whose corners are hair. A triangle is filed by majority
# vote, so one with two corners on the skull and one on the NECK counts as hair — and its uv polygon covers neck texels
# where the sculpt's paint has a brown smudge. Protected as "the crop's own", that smudge survived every cleanup and
# read as a patch under the skull (2026-09-20, the user: "a weird brown piece on the neck").
allHair = lambda t: all(classes[vclass[idx[t + k]]] == 'hair' for k in range(3))
mask = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(mask)
for t in range(0, len(idx), 3):
    if not allHair(t): continue
    dr.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
# THE SPILL (2026-09-20, the user: "a weird brown piece on the neck"). The sculpt's painted hair does not stop at its uv
# island: a few texels of it lie in the NECK's island next door, and neck triangles sample them — a brown patch under the
# skull. Harmless while the whole hair region was flattened to skin, plain once the paint stays. So the paint is kept
# inside its own triangles: in a band just outside them, anything as dark as hair is taken back to skin.
poly = mask.copy()                                          # the hair triangles exactly, before any dilation
near = poly.filter(ImageFilter.MaxFilter(5)); npx_near = near.load()    # a couple of texels outside the crop: its own soft hairline, left alone (the inpaint below blends what is taken, so this can be tight — at 13 the blob under the nape survived)
band = poly.filter(ImageFilter.MaxFilter(41)); bpx = band.load()        # as far as the spill reaches
# the texels the NECK and the rest of the head actually cover. Only there is spilt hair paint wrong: between the islands
# lies the gutter, and the gutter must keep the paint — bilinear sampling reaches into it, and cutting it left the
# hairline sawn along the triangle edges.
other = Image.new('L', (W, H), 0); dro = ImageDraw.Draw(other)
for t in range(0, len(idx), 3):
    if allHair(t) or classes[tri[t // 3]] == 'beard': continue
    dro.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
other = other.filter(ImageFilter.MinFilter(3)); opx = other.load()   # (a texel right on the seam is shared: leave it)
# THE BACK OF THE SKULL. The sculpt's paint carries marks there that are nobody's hair and nobody's feature — two dark
# hooks under the hairline, mirrored left and right, that read on the model as something stuck to the neck (2026-09-20,
# the user, twice: "a weird brown piece on the neck", "i can still see this shit here"). Anything darker than the skin
# around it is taken out THERE, where there is no feature to lose. The face is not in this mask: its dark paint is the
# eyes, the nostrils, the mouth, and it must stay.
back = Image.new('L', (W, H), 0); drb = ImageDraw.Draw(back)
for t in range(0, len(idx), 3):
    if allHair(t): continue
    if not all(pos[idx[t + k] * 3 + 2] < -0.01 and pos[idx[t + k] * 3 + 1] > 1.75 for k in range(3)): continue
    drb.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
kpx = back.load()
covered = Image.new('L', (W, H), 0); drc = ImageDraw.Draw(covered)   # every texel a triangle of the head actually owns (the rest is gutter)
for t in range(0, len(idx), 3):
    drc.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
cpx = covered.load()
mask = mask.filter(ImageFilter.MaxFilter(5))
N = A.copy(); npx = N.load(); mpx = mask.load(); spill = []
for y in range(H):
    for x in range(W):
        if y >= 1024: continue                                # (the lower half is not skin: the eyes at the left keep their paint, Thor's leather, cloth and steel — Equip_01 at (1024,1024), Equip_02/03 at y 1280 — must not take the skin's gain)
        r, gg, b = px[x, y]
        # THE PAINTED CROP STAYS PAINTED (2026-09-20). It used to be flattened to the skin tone so the look's colour
        # could paint it from the VERTICES — but a low-poly skull cannot hold a hairline in vertex colour and the man
        # read as bald, then (greyed) as a jagged cap: the mask is per TRIANGLE, so its edge is the mesh's, not the
        # paint's. The beard was never flattened and always read right, so the hair is now treated the same way: the
        # paint keeps the hairline and the strand shading, and the look's colour multiplies over it — game.js divides
        # the chosen colour by this region's mean (LOOK_HAIR_TEX) so colour x texture lands back on the swatch.
        l = (0.299 * r + 0.587 * gg + 0.114 * b) / 255
        npx[x, y] = (min(255, int(r * gain[0])), min(255, int(gg * gain[1])), min(255, int(b * gain[2])))
# WHERE THE SPILL IS. Not "darker than some fixed level" — the gain lifts everything and the smudge on the nape is only
# a little browner than the skin round it, so an absolute threshold walked straight past the very patch the user saw.
# A LOCAL test instead: on the crop's neighbours (its band, on triangles that are not the crop's own and not the beard's)
# a texel counts as spilt when it is darker than the skin blurred around it.
# the LOCAL SKIN LEVEL, measured with the crop's own paint left out (a plain blur next to the hairline is mostly hair,
# so the smudge never looked dark "for its surroundings" and every threshold walked past it). Normalised convolution:
# blur the image with the crop blacked out, blur the validity mask the same way, divide.
_v = poly.point(lambda p: 0 if p else 255)
_a = N.copy(); _ap = _a.load(); _pp = poly.load()
for y in range(0, 1024):
    for x in range(W):
        if _pp[x, y]: _ap[x, y] = (0, 0, 0)
_bc = _a.filter(ImageFilter.GaussianBlur(25)).load(); _bw = _v.filter(ImageFilter.GaussianBlur(25)).load()
local = {}
for y in range(H):
    for x in range(W):
        if y >= 1024: continue
        if kpx[x, y]: cut = 0.96                             # the back of the skull: no hairline to spare there — the marks sit right against the crop's own texels, and sparing them is what left them behind. Anything below the skin around it goes.
        elif bpx[x, y] and opx[x, y] and not npx_near[x, y]: cut = 0.90
        else: continue
        w = _bw[x, y] / 255
        if w < 0.05: continue
        c0 = npx[x, y]; c1 = tuple(_bc[x, y][k] / w for k in range(3))
        l0 = 0.299 * c0[0] + 0.587 * c0[1] + 0.114 * c0[2]; l1 = 0.299 * c1[0] + 0.587 * c1[1] + 0.114 * c1[2]
        if l0 < l1 * cut: spill.append((x, y))
# INPAINT the spill from the skin around it. Painting it a flat tone — the palette cell, or even the mean gained skin —
# left a bright slash: these texels sit among dark sideburn paint, and any fixed colour is wrong for its neighbourhood.
# So each spilt texel takes a weighted average of the SOUND pixels near it (a normalised convolution: blur the image
# with the spill blacked out, blur the validity mask the same way, divide), which lands it in its own surroundings.
if spill:
    sp = Image.new('L', (W, H), 255); dsp = ImageDraw.Draw(sp)
    for x, y in spill: dsp.point((x, y), fill=0)
    for _ in range(2):
        A2 = N.copy(); a2 = A2.load()
        for x, y in spill: a2[x, y] = (0, 0, 0)
        blurC = A2.filter(ImageFilter.GaussianBlur(9)).load(); blurW = sp.filter(ImageFilter.GaussianBlur(9)).load()
        for x, y in spill:
            w = blurW[x, y] / 255
            if w > 0.02: npx[x, y] = tuple(min(255, int(blurC[x, y][k] / w)) for k in range(3))
    print('hair spill inpainted:', len(spill), 'texels')
    # AND PAD IT INTO THE GUTTER. The strip between two uv islands belongs to no triangle, so the repair never reached
    # it — but bilinear sampling at the island's edge does, and the old dark paint waiting there drew a thin line along
    # the hairline. The mended skin is spread a few texels outwards over that no-man's-land.
    edge = back.filter(ImageFilter.MaxFilter(15)); epx = edge.load()
    gut = [(x, y) for y in range(1024) for x in range(W) if epx[x, y] and not cpx[x, y]]
    if gut:
        v2 = Image.new('L', (W, H), 0); d2 = ImageDraw.Draw(v2)
        A3 = N.copy(); a3 = A3.load()
        for y in range(1024):
            for x in range(W):
                if cpx[x, y]: d2.point((x, y), fill=255)
                else: a3[x, y] = (0, 0, 0)
        bc = A3.filter(ImageFilter.GaussianBlur(7)).load(); bw = v2.filter(ImageFilter.GaussianBlur(7)).load()
        for x, y in gut:
            w = bw[x, y] / 255
            if w > 0.02: npx[x, y] = tuple(min(255, int(bc[x, y][k] / w)) for k in range(3))
        print('gutter padded:', len(gut), 'texels')
N.save(out + 'atlas.jpg', quality=88); mask.save(out + 'hair_mask.png')
hairPx = [npx[x, y] for y in range(0, H, 2) for x in range(0, W, 2) if mpx[x, y]]
if hairPx:
    mean = [sum(p[k] for p in hairPx) / len(hairPx) / 255 for k in range(3)]
    print('hair mean after gain (game.js LOOK_HAIR_TEX):', [round(m, 3) for m in mean])
print('atlas normalised; hair mask px', len(hairPx) * 4)
