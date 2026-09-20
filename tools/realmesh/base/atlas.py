# one 2048x2048 atlas for the base body: body colour (0,0), head (1024,0), eyes (0,1024) 256px, a plain skin patch (256,1024) 256px
import json, sys
from PIL import Image, ImageFilter
src = 'thor/0/'; out = sys.argv[1] if len(sys.argv) > 1 else 'build/base/'
import os; os.makedirs(out, exist_ok=True)
body = Image.open(src + 'MI_1039506_Body_baseColor.jpg').convert('RGB'); head = Image.open(src + 'MI_1039506_Head_baseColor.jpg').convert('RGB'); eyes = Image.open(src + 'MI_1039506_Eyes_01_baseColor.jpg').convert('RGB')
A = Image.new('RGB', (2048, 2048), (120, 80, 60)); A.paste(body, (0, 0)); A.paste(head, (1024, 0)); A.paste(eyes.resize((256, 256)), (0, 1024))
band = Image.open(src + 'MI_1039506_Equip_01_baseColor.jpg').convert('RGB'); A.paste(band.resize((1024, 1024)), (1024, 1024))
# his pants, boots and shin wraps are his LEGS — the body mesh has none, they lived under these — so they come too, at 512
for nm, xy in (('Equip_02', (0, 1280)), ('Equip_03', (512, 1280))):
    A.paste(Image.open(src + 'MI_1039506_%s_baseColor.jpg' % nm).convert('RGB').resize((512, 512)), xy)   # the wrist band's leather: the naked man keeps it, it covers the wrist where his hand has no skin
# the plainest skin-coloured 96px window of the body texture -> a 256px patch (blurred a touch so the tubes read as skin, not as a crop)
sm = body.resize((128, 128)); px = sm.load(); best = None
for y in range(0, 128 - 12):
    for x in range(0, 128 - 12):
        vals = [px[x + i, y + j] for i in range(12) for j in range(12)]; r = sum(v[0] for v in vals) / 144; g = sum(v[1] for v in vals) / 144; b = sum(v[2] for v in vals) / 144
        var = sum((v[0] - r) ** 2 + (v[1] - g) ** 2 + (v[2] - b) ** 2 for v in vals) / 144
        if r < 140 or r < g + 20: continue
        if best is None or var < best[0]: best = (var, x, y, (r, g, b))
var, x, y, mean = best; print('patch window', x * 8, y * 8, 'var', round(var, 1), 'mean', [round(m) for m in mean])
patch = body.crop((x * 8, y * 8, x * 8 + 96, y * 8 + 96)).resize((256, 256), Image.BICUBIC).filter(ImageFilter.GaussianBlur(3))
# tint the patch to the body's mean skin (sampled where the body's vertices actually point, lum.json's uvs)
import struct
g = json.load(open('thor-gltf/scene.gltf')); bb = open('thor-gltf/scene.bin', 'rb').read()
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = {'VEC2': 2, 'VEC3': 3}[a['type']]
    return struct.unpack_from('<%df' % (a['count'] * n), bb, bv.get('byteOffset', 0) + a.get('byteOffset', 0))
node = [n for n in g['nodes'] if n.get('mesh') is not None and 'Body' in n['name']][0]; uv = acc(g['meshes'][node['mesh']]['primitives'][0]['attributes']['TEXCOORD_0']); bp = body.load()
cols = [bp[min(1023, int((uv[i*2] % 1) * 1024)), min(1023, int((uv[i*2+1] % 1) * 1024))] for i in range(len(uv) // 2)]
cols = [c for c in cols if (c[0] + c[1] + c[2]) > 200]; mean = tuple(sum(c[k] for c in cols) / len(cols) for k in range(3)); print('body mean skin', [round(m) for m in mean])
pp = patch.load(); pm = [0, 0, 0]
for yy in range(256):
    for xx in range(256):
        for k in range(3): pm[k] += pp[xx, yy][k] / 65536
gain = [mean[k] / pm[k] for k in range(3)]
for yy in range(256):
    for xx in range(256):
        r, gg2, b2 = pp[xx, yy]; pp[xx, yy] = (min(255, int(r * gain[0])), min(255, int(gg2 * gain[1])), min(255, int(b2 * gain[2])))
A.paste(patch, (256, 1024))
A.save(out + 'atlas_raw.jpg', quality=95)
# normal atlas: body/head normals (512) upscaled into the same slots, flat elsewhere
bn = Image.open(src + 'MI_1039506_Body_normal.jpg').convert('RGB'); hn = Image.open(src + 'MI_1039506_Head_normal.jpg').convert('RGB')
def flatten(im):
    im = im.convert('RGB'); px = im.load(); W, H = im.size
    for y in range(H):
        for x in range(W):
            r, g, b = px[x, y]
            if b < 90 or (r + g + b) < 120: px[x, y] = (128, 128, 255)
    return im
N = Image.new('RGB', (2048, 2048), (128, 128, 255)); N.paste(flatten(bn).resize((1024, 1024)), (0, 0)); N.paste(flatten(hn).resize((1024, 1024)), (1024, 0)); N.save(out + 'atlas_normal.jpg', quality=85)
json.dump({'body': [0, 0, 0.5, 0.5], 'head': [0.5, 0, 0.5, 0.5], 'eyes': [0, 0.5, 0.125, 0.125], 'skin': [0.125, 0.5, 0.125, 0.125], 'band': [0.5, 0.5, 0.5, 0.5], 'legs': [0, 0.625, 0.25, 0.25], 'wraps': [0.25, 0.625, 0.25, 0.25], 'skinMean': [round(m) for m in mean]}, open(out + 'atlas.json', 'w'))
hp = Image.open(src + 'MI_1039506_Hair_01_baseColor.png').convert('RGBA'); hpx = hp.load(); W2, H2 = hp.size
lums = [0.299 * hpx[x, y][0] + 0.587 * hpx[x, y][1] + 0.114 * hpx[x, y][2] for y in range(0, H2, 4) for x in range(0, W2, 4) if hpx[x, y][3] > 128]; ml = sum(lums) / len(lums); k = 205 / ml
for y in range(H2):
    for x in range(W2):
        r, g, b, al = hpx[x, y]; l = 0.299 * r + 0.587 * g + 0.114 * b; l = max(0, min(255, int(205 + (l - ml) * 0.35))); hpx[x, y] = (l, l, l, al)   # (contrast flattened: the scalp cards were painted darker than the strands and read as a grey cap under white hair)
hp.save(out + 'hair.png'); print('hair card texture: mean lum', round(ml), '-> 205')
print('atlas written')
