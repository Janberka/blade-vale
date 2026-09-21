# THE SKIN FOR THE GAME'S TINTS — an adopted body's atlas, as the game wants it (wardrobe.js --ship runs this).
#   python3 tools/realmesh/adopt/skinbake.py <rig dir> [--raw <where the painted atlas is kept for the char editor>]
# The game does not show a body's painted skin as painted: every fighter has a TONE (ten of them, the barber's pick or the
# roll of his name), laid on as a vertex tint, tint x paint. For that the paint has to be NEUTRAL: game.js (lookApply)
# divides the tone by the palette's skin cell #ffdcb4 and lifts it x1.16, which comes out right when the body's BRIGHT skin
# (its 92nd percentile) sits AT that cell — the highlights keep their shape, the mean lands ~0.86 of it. headbake.py does
# this for the base; this is the same rule for any body, with one difference that matters: an adopted model paints its
# skin, its cloth and its leather on ONE sheet, so only the SKIN's texels may move. The mask is the body mesh's own
# triangles (every class but the eyes) drawn into uv space, grown by a texel for the seams; what he wears keeps its paint.
import json, struct, sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops
out = sys.argv[1].rstrip('/') + '/'; raw_to = sys.argv[sys.argv.index('--raw') + 1] if '--raw' in sys.argv else None
g = json.load(open(out + 'scene.gltf')); bb = open(out + g['buffers'][0]['uri'], 'rb').read()
FMT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]; f = FMT[a['componentType']]
    return struct.unpack_from('<%d%s' % (a['count'] * n, f), bb, bv.get('byteOffset', 0) + a.get('byteOffset', 0))
node = [n for n in g['nodes'] if n.get('mesh') is not None and n['name'] == 'base_body'][0]; p = g['meshes'][node['mesh']]['primitives'][0]
uv = acc(p['attributes']['TEXCOORD_0']); idx = acc(p['indices']); nv = len(uv) // 2
pj = json.load(open(out + 'pieces.json'))['body']; cls = [pj['classes'][c] for c in pj['vclass']]
atlas = out + 'atlas.jpg'; A = Image.open(atlas).convert('RGB'); W, H = A.size; px = A.load()
if raw_to: os.makedirs(os.path.dirname(raw_to), exist_ok=True); A.save(raw_to, quality=92)
skin = [v for v in range(nv) if cls[v] not in ('eye', 'hair', 'beard', 'brow', 'socket')]
cols = [px[min(W - 1, max(0, int(uv[v * 2] * W))), min(H - 1, max(0, int(uv[v * 2 + 1] * H)))] for v in skin]
TARGET = (255, 220, 180); p92 = [sorted(c[k] for c in cols)[int(len(cols) * 0.92)] for k in range(3)]; mean = [sum(c[k] for c in cols) / len(cols) for k in range(3)]
gain = [TARGET[k] / max(1, p92[k]) for k in range(3)]
mask = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(mask)
for t in range(0, len(idx), 3):
    if any(cls[idx[t + k]] == 'eye' for k in range(3)): continue
    dr.polygon([(uv[idx[t + k] * 2] * W, uv[idx[t + k] * 2 + 1] * H) for k in range(3)], fill=255)
mask = mask.filter(ImageFilter.MaxFilter(3))
chans = [c.point(lambda v, k=gain[i]: min(255, int(v * k + 0.5))) for i, c in enumerate(A.split())]
B = Image.composite(Image.merge('RGB', chans), A, mask); B.save(atlas, quality=92)
cover = sum(1 for v in mask.getdata() if v) / float(W * H)
print('skin: mean', [round(m) for m in mean], 'p92', p92, '-> gain', [round(x, 3) for x in gain], '· mean after', [round(mean[k] * gain[k]) for k in range(3)], '· %d%% of the sheet is skin' % round(cover * 100))
