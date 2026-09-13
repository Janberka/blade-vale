// minimal glTF 2.0 reader for r128 global three: one .bin, POSITION/NORMAL/TEXCOORD_0 + indices, one baseColor png
window.loadMiniGLTF = async function (dir) {
  const g = await (await fetch(dir + '/scene.gltf')).json();
  const bin = await (await fetch(dir + '/' + g.buffers[0].uri)).arrayBuffer();
  const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function acc(i) {
    const a = g.accessors[i], bv = g.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (bv.byteStride && bv.byteStride !== n * T.BYTES_PER_ELEMENT) {
      const out = new T(a.count * n), stride = bv.byteStride / T.BYTES_PER_ELEMENT, src = new T(bin, off, (a.count - 1) * stride + n);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = src[k * stride + c];
      return new THREE.BufferAttribute(out, n);
    }
    return new THREE.BufferAttribute(new T(bin, off, a.count * n), n);
  }
  let tex = null;
  if (g.images && g.images.length) { tex = new THREE.TextureLoader().load(dir + '/' + g.images[0].uri); tex.encoding = THREE.sRGBEncoding; tex.flipY = false; }
  const mat = new THREE.MeshStandardMaterial({ map: tex, metalness: (g.materials && g.materials[0].pbrMetallicRoughness.metallicFactor) || 0, roughness: (g.materials && g.materials[0].pbrMetallicRoughness.roughnessFactor) ?? 1 });
  const root = new THREE.Group();
  function node(i, parent) {
    const n = g.nodes[i], o = new THREE.Group(); parent.add(o);
    if (n.matrix) o.applyMatrix4(new THREE.Matrix4().fromArray(n.matrix));
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    if (n.mesh != null) for (const p of g.meshes[n.mesh].primitives) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', acc(p.attributes.POSITION));
      if (p.attributes.NORMAL != null) geo.setAttribute('normal', acc(p.attributes.NORMAL));
      if (p.attributes.TEXCOORD_0 != null) geo.setAttribute('uv', acc(p.attributes.TEXCOORD_0));
      if (p.indices != null) geo.setIndex(acc(p.indices));
      o.add(new THREE.Mesh(geo, mat));
    }
    (n.children || []).forEach(c => node(c, o));
  }
  g.scenes[g.scene || 0].nodes.forEach(i => node(i, root));
  return root;
};
