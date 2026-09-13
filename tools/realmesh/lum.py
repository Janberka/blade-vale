# per-triangle texture luminance for a decimated model: tri-lum.bin (float32 per triangle), sampled at the UV centroid
import json, struct, sys, array
from PIL import Image
d = sys.argv[1]; g = json.load(open(d + '/scene.gltf')); bin = open(d + '/scene.bin', 'rb').read()
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]; fmt = {5123: 'H', 5125: 'I', 5126: 'f'}[a['componentType']]
    arr = array.array(fmt); arr.frombytes(bin[off: off + a['count'] * n * arr.itemsize]); return arr, n
p = g['meshes'][0]['primitives'][0]; uv, _ = acc(p['attributes']['TEXCOORD_0']); idx, _ = acc(p['indices'])
im = Image.open(d + '/' + g['images'][0]['uri']).convert('L'); W, H = im.size; px = im.load()
out = array.array('f')
for i in range(0, len(idx), 3):
    u = (uv[idx[i]*2] + uv[idx[i+1]*2] + uv[idx[i+2]*2]) / 3; v = (uv[idx[i]*2+1] + uv[idx[i+1]*2+1] + uv[idx[i+2]*2+1]) / 3
    x = min(W-1, max(0, int((u % 1) * W))); y = min(H-1, max(0, int((v % 1) * H)))
    out.append(px[x, y] / 255.0)
open(d + '/tri-lum.bin', 'wb').write(out.tobytes()); print('tris', len(out), 'dark(<0.16)', sum(1 for l in out if l < 0.16))
