import json, struct, sys
from collections import Counter, defaultdict
base = sys.argv[1] if len(sys.argv) > 1 else 'thor-gltf/'
g = json.load(open(base + 'scene.gltf')); bin = open(base + g['buffers'][0]['uri'], 'rb').read()
FMT = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]; f = FMT[a['componentType']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); return struct.unpack_from('<%d%s' % (a['count'] * n, f), bin, off)
bones = json.load(open(base + 'bones.json')); bname = [b['path'].split('/')[-1] for b in bones]
used = defaultdict(float); usedMesh = defaultdict(lambda: defaultdict(float))
for node in g['nodes']:
    if node.get('mesh') is None: continue
    p = g['meshes'][node['mesh']]['primitives'][0]; sk = g['skins'][node['skin']]
    pos = acc(p['attributes']['POSITION']); ji = acc(p['attributes']['JOINTS_0']); w = acc(p['attributes']['WEIGHTS_0'])
    nv = len(pos) // 3
    mn = [min(pos[i::3]) for i in range(3)]; mx = [max(pos[i::3]) for i in range(3)]
    short = node['name'].replace('SK_1039_1039506_mo_MI_1039506_', '').replace('_0', '')
    print('MESH', short, 'verts', nv, 'bbox', [round(v, 2) for v in mn], [round(v, 2) for v in mx])
    for v in range(nv):
        for c in range(4):
            if w[v*4+c] > 0: b = sk['joints'][ji[v*4+c]]; used[b] += w[v*4+c]; usedMesh[short][b] += w[v*4+c]
    top = sorted(usedMesh[short].items(), key=lambda kv: -kv[1])[:40]
    print('   bones:', ', '.join('%s:%.0f' % (bname[b], s) for b, s in top))
print('bones with any weight:', len(used), 'of', len(bones))
kids = defaultdict(list)
for b in bones: kids[b['parent']].append(b)
def pr(i, d):
    for j in kids[i]:
        w = used.get(j['i'], 0); print('  ' * d + bname[j['i']], [round(x, 3) for x in j['pos']], ('w=%.0f' % w) if w else '')
        pr(j['i'], d + 1)
pr(-1, 0)
