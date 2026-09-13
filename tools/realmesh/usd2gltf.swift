// USD -> glTF 2.0 with skins, ModelIO only.
import Foundation
import ModelIO
import simd

setvbuf(stdout, nil, _IONBF, 0)
let src = URL(fileURLWithPath: CommandLine.arguments[1]), outDir = URL(fileURLWithPath: CommandLine.arguments[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let asset = MDLAsset(url: src); asset.loadTextures()
var meshes: [MDLMesh] = []
func walk(_ o: MDLObject, _ d: Int) { if let m = o as? MDLMesh { meshes.append(m) }; for i in 0..<o.children.count { walk(o.children[i], d + 1) } }
for i in 0..<asset.count { walk(asset.object(at: i), 0) }
print("meshes:", meshes.count)
guard let bind0 = meshes.first?.componentConforming(to: MDLComponent.self) else { print("?"); exit(1) }
var skeleton: MDLSkeleton? = nil
for m in meshes { if let b = m.componentConforming(to: MDLComponent.self) as? MDLAnimationBindComponent, let s = b.skeleton { skeleton = s; break } }
guard let skel = skeleton else { print("no skeleton"); exit(1) }
let paths = skel.jointPaths; print("joints:", paths.count, paths.prefix(5))
let restLocal = skel.jointRestTransforms.float4x4Array, bindWorld = skel.jointBindTransforms.float4x4Array
print("rest count", restLocal.count, "bind count", bindWorld.count)
// hierarchy from paths
func parentPath(_ p: String) -> String? { guard let r = p.range(of: "/", options: .backwards) else { return nil }; return String(p[..<r.lowerBound]) }
let pathIndex = Dictionary(uniqueKeysWithValues: paths.enumerated().map { ($0.element, $0.offset) })
let parents: [Int] = paths.map { parentPath($0).flatMap { pathIndex[$0] } ?? -1 }

var bin = Data(); var bufferViews: [[String: Any]] = [], accessors: [[String: Any]] = []
func align() { while bin.count % 4 != 0 { bin.append(0) } }
func pushView(_ d: Data, target: Int? = nil) -> Int { align(); let off = bin.count; bin.append(d); var v: [String: Any] = ["buffer": 0, "byteOffset": off, "byteLength": d.count]; if let t = target { v["target"] = t }; bufferViews.append(v); return bufferViews.count - 1 }
func accF(_ arr: [Float], comps: Int, type: String, target: Int? = nil, minmax: Bool = false) -> Int {
  let d = arr.withUnsafeBufferPointer { Data(buffer: $0) }; let bv = pushView(d, target: target); var a: [String: Any] = ["bufferView": bv, "componentType": 5126, "count": arr.count / comps, "type": type]
  if minmax { var mn = [Float](repeating: .greatestFiniteMagnitude, count: comps), mx = [Float](repeating: -.greatestFiniteMagnitude, count: comps); for i in 0..<(arr.count / comps) { for c in 0..<comps { mn[c] = min(mn[c], arr[i * comps + c]); mx[c] = max(mx[c], arr[i * comps + c]) } }; a["min"] = mn; a["max"] = mx }
  accessors.append(a); return accessors.count - 1 }
func accU16(_ arr: [UInt16], comps: Int, type: String, target: Int? = nil) -> Int { let d = arr.withUnsafeBufferPointer { Data(buffer: $0) }; let bv = pushView(d, target: target); accessors.append(["bufferView": bv, "componentType": 5123, "count": arr.count / comps, "type": type]); return accessors.count - 1 }
func accU32(_ arr: [UInt32]) -> Int { let d = arr.withUnsafeBufferPointer { Data(buffer: $0) }; let bv = pushView(d, target: 34963); accessors.append(["bufferView": bv, "componentType": 5125, "count": arr.count, "type": "SCALAR"]); return accessors.count - 1 }
func m16(_ m: simd_float4x4) -> [Float] { (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } } }

// joint nodes with local rest transforms
var gNodes: [[String: Any]] = []
for (i, p) in paths.enumerated() { var g: [String: Any] = ["name": String(p.split(separator: "/").last ?? "j"), "matrix": m16(restLocal[i])]; let kids = parents.enumerated().filter { $0.element == i }.map { $0.offset }; if !kids.isEmpty { g["children"] = kids }; gNodes.append(g) }
let roots = parents.enumerated().filter { $0.element == -1 }.map { $0.offset }
let ibm: [Float] = bindWorld.flatMap { m16($0.inverse) }
let ibmAcc = accF(ibm, comps: 16, type: "MAT4")
var gMeshes: [[String: Any]] = [], skins: [[String: Any]] = [], meshNodeIdx: [Int] = []; var texName = "texture.jpg"; var texWritten = false
for m in meshes {
  guard let b = m.componentConforming(to: MDLComponent.self) as? MDLAnimationBindComponent else { print("unskinned mesh", m.name); continue }
  let gd = b.geometryBindTransform; var geomBind = simd_float4x4(simd_float4(gd.columns.0), simd_float4(gd.columns.1), simd_float4(gd.columns.2), simd_float4(gd.columns.3)); let det = geomBind.determinant; if !(abs(det) > 1e-8) || !det.isFinite { geomBind = matrix_identity_float4x4 }; let nb = geomBind.inverse.transpose; print("geomBind det", det)
  let jp = b.jointPaths ?? paths                      // the mesh's joint order (indices refer to this)
  let jmap = jp.map { pathIndex[$0] ?? 0 }
  func attr(_ name: String, _ fmt: MDLVertexFormat, _ comps: Int) -> [Float]? { guard let d = m.vertexAttributeData(forAttributeNamed: name, as: fmt) else { return nil }; var out = [Float](repeating: 0, count: m.vertexCount * comps); for i in 0..<m.vertexCount { let base = d.dataStart.advanced(by: i * d.stride); for c in 0..<comps { out[i * comps + c] = base.load(fromByteOffset: c * 4, as: Float.self) } }; return out }
  let nv = m.vertexCount
  guard var P = attr(MDLVertexAttributePosition, .float3, 3) else { continue }
  var N = attr(MDLVertexAttributeNormal, .float3, 3) ?? [], uv = attr(MDLVertexAttributeTextureCoordinate, .float2, 2) ?? []
  for i in 0..<nv { let p = geomBind * simd_float4(P[i*3], P[i*3+1], P[i*3+2], 1); P[i*3] = p.x; P[i*3+1] = p.y; P[i*3+2] = p.z; if N.count == nv * 3 { let q = simd_normalize(nb * simd_float4(N[i*3], N[i*3+1], N[i*3+2], 0)); N[i*3] = q.x; N[i*3+1] = q.y; N[i*3+2] = q.z } }
  if uv.count == nv * 2 { for i in 0..<nv { uv[i*2+1] = 1 - uv[i*2+1] } }
  // joints / weights straight from the vertex buffers (ModelIO's format conversion mangles 1-component attributes)
  func raw(_ name: String) -> (vals: [Float], comps: Int)? {
    guard let a = (m.vertexDescriptor.attributes as! [MDLVertexAttribute]).first(where: { $0.name == name && $0.format != .invalid }) else { return nil }
    let comps = Int(a.format.rawValue & 0xFF), kind = a.format.rawValue >> 16, layout = (m.vertexDescriptor.layouts as! [MDLVertexBufferLayout])[a.bufferIndex], stride = layout.stride
    let buf = m.vertexBuffers[a.bufferIndex].map().bytes; var out = [Float](repeating: 0, count: m.vertexCount * comps)
    for i in 0..<m.vertexCount { let base = i * stride + a.offset; for c in 0..<comps { switch kind {
      case 0x3: out[i * comps + c] = Float(buf.load(fromByteOffset: base + c, as: UInt8.self))
      case 0x5: out[i * comps + c] = Float(buf.load(fromByteOffset: base + c * 2, as: UInt16.self))
      case 0x7: out[i * comps + c] = Float(buf.load(fromByteOffset: base + c * 4, as: UInt32.self))
      case 0xC: out[i * comps + c] = buf.load(fromByteOffset: base + c * 4, as: Float.self)
      default: out[i * comps + c] = Float(buf.load(fromByteOffset: base + c * 2, as: UInt16.self)) } } }
    return (out, comps) }
  let jr = raw(MDLVertexAttributeJointIndices), wr = raw(MDLVertexAttributeJointWeights)
  var J = [UInt16](repeating: 0, count: nv * 4), W = [Float](repeating: 0, count: nv * 4)
  for i in 0..<nv { var sum: Float = 0
    for c in 0..<4 { let jc = jr?.comps ?? 0, wc = wr?.comps ?? 0
      let j = c < jc ? Int(jr!.vals[i * jc + c]) : 0, w: Float = c < wc ? wr!.vals[i * wc + c] : (jc > 0 && wc == 0 && c == 0 ? 1 : 0)
      J[i*4+c] = UInt16((j >= 0 && j < jmap.count && c < max(jc, 1)) ? j : 0); W[i*4+c] = c < max(jc, 1) ? w : 0; sum += W[i*4+c] }
    if sum > 0 { for c in 0..<4 { W[i*4+c] /= sum } } else { W[i*4] = 1 } }
  print("  joints comps", jr?.comps ?? 0, "weights comps", wr?.comps ?? 0)
  var idx: [UInt32] = []
  for sub in (m.submeshes as? [MDLSubmesh]) ?? [] { let ib = sub.indexBuffer.map(); for k in 0..<sub.indexCount { switch sub.indexType { case .uInt16: idx.append(UInt32(ib.bytes.load(fromByteOffset: k * 2, as: UInt16.self))); case .uInt8: idx.append(UInt32(ib.bytes.load(fromByteOffset: k, as: UInt8.self))); default: idx.append(ib.bytes.load(fromByteOffset: k * 4, as: UInt32.self)) } }
    if !texWritten, let mat = sub.material, let prop = mat.property(with: .baseColor) { if let u = prop.urlValue { try? FileManager.default.copyItem(at: u, to: outDir.appendingPathComponent(u.lastPathComponent)); texName = u.lastPathComponent; texWritten = true } else if let s = prop.stringValue { texName = (s as NSString).lastPathComponent; texWritten = true } } }
  var attrs: [String: Any] = ["POSITION": accF(P, comps: 3, type: "VEC3", target: 34962, minmax: true), "JOINTS_0": accU16(J, comps: 4, type: "VEC4", target: 34962), "WEIGHTS_0": accF(W, comps: 4, type: "VEC4", target: 34962)]
  if N.count == nv * 3 { attrs["NORMAL"] = accF(N, comps: 3, type: "VEC3", target: 34962) }
  if uv.count == nv * 2 { attrs["TEXCOORD_0"] = accF(uv, comps: 2, type: "VEC2", target: 34962) }
  gMeshes.append(["name": m.name, "primitives": [["attributes": attrs, "indices": accU32(idx), "material": 0]]])
  // this mesh's skin: joints in ITS order, IBMs picked from the skeleton's bind transforms
  let ibmM: [Float] = jmap.flatMap { m16(bindWorld[$0].inverse) }
  skins.append(["joints": jmap, "inverseBindMatrices": accF(ibmM, comps: 16, type: "MAT4"), "skeleton": roots.first ?? 0])
  gNodes.append(["name": m.name, "mesh": gMeshes.count - 1, "skin": skins.count - 1]); meshNodeIdx.append(gNodes.count - 1)
  print("mesh", m.name, "verts", nv, "tris", idx.count / 3, "joints(mesh)", jp.count,  "pos0", P[0], P[1], P[2])
}
gNodes.append(["name": "root", "children": roots + meshNodeIdx])
let gltf: [String: Any] = ["asset": ["version": "2.0", "generator": "bv-usd-export"], "scene": 0, "scenes": [["nodes": [gNodes.count - 1]]], "nodes": gNodes, "meshes": gMeshes, "skins": skins,
  "materials": [["name": "warrior", "pbrMetallicRoughness": ["baseColorTexture": ["index": 0], "metallicFactor": 0, "roughnessFactor": 0.9]]],
  "textures": [["source": 0, "sampler": 0]], "samplers": [["magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497]], "images": [["uri": texName]],
  "buffers": [["uri": "scene.bin", "byteLength": bin.count]], "bufferViews": bufferViews, "accessors": accessors]
try! bin.write(to: outDir.appendingPathComponent("scene.bin"))
try! JSONSerialization.data(withJSONObject: gltf, options: []).write(to: outDir.appendingPathComponent("scene.gltf"))
var dump: [[String: Any]] = []; for (i, p) in paths.enumerated() { let w = bindWorld[i].columns.3; dump.append(["i": i, "path": p, "parent": parents[i], "pos": [w.x, w.y, w.z]]) }
try! JSONSerialization.data(withJSONObject: dump, options: [.prettyPrinted]).write(to: outDir.appendingPathComponent("bones.json"))
print("wrote nodes", gNodes.count, "bin KB", bin.count / 1024, "tex", texName)
