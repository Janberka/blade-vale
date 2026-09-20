// USD → the skeleton and its bound SkelAnimation as JSON, for motion.js (ModelIO only, like usd2gltf.swift).
//   swiftc -O usdanim.swift -o /tmp/usdanim && /tmp/usdanim <in.usdz> <out.json>
// Writes { joints, parents, rest (local 4x4), bind (world 4x4), clips: [{ name, times, t, r, s }] } — every matrix
// column-major, every quaternion x y z w, one flat array per key. NOTE a USD skeleton binds ONE animation: a Sketchfab
// "N motions" model converted to .usdz carries only its first clip (the glTF download has them all).
import Foundation
import ModelIO
import simd
setvbuf(stdout, nil, _IONBF, 0)
let src = URL(fileURLWithPath: CommandLine.arguments[1]), out = URL(fileURLWithPath: CommandLine.arguments[2])
let asset = MDLAsset(url: src)
var skel: MDLSkeleton? = nil, skelObj: MDLObject? = nil
func walk(_ o: MDLObject) { if let s = o as? MDLSkeleton, skel == nil { skel = s; skelObj = o }; for i in 0..<o.children.count { walk(o.children[i]) } }
for i in 0..<asset.count { walk(asset.object(at: i)) }
guard let sk = skel else { print("no skeleton"); exit(1) }
func m16(_ m: simd_float4x4) -> [Float] { (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } } }
let paths = sk.jointPaths
let idx = Dictionary(uniqueKeysWithValues: paths.enumerated().map { ($0.element, $0.offset) })
func parentPath(_ p: String) -> String? { guard let r = p.range(of: "/", options: .backwards) else { return nil }; return String(p[..<r.lowerBound]) }
let parents = paths.map { parentPath($0).flatMap { idx[$0] } ?? -1 }
let world = MDLTransform.globalTransform(with: skelObj!, atTime: 0)
var js: [String: Any] = ["joints": paths, "parents": parents,
  "rest": sk.jointRestTransforms.float4x4Array.map(m16), "bind": sk.jointBindTransforms.float4x4Array.map(m16),
  "skelWorld": m16(world), "start": asset.startTime, "end": asset.endTime, "frameInterval": asset.frameInterval]
var clips: [[String: Any]] = []
for a in asset.animations.objects { guard let p = a as? MDLPackedJointAnimation else { continue }
  let times = Array(Set(p.rotations.times + p.translations.times)).sorted()
  var T: [[Float]] = [], R: [[Float]] = [], S: [[Float]] = []
  for t in times {
    let tr = p.translations.float3Array(atTime: t), ro = p.rotations.floatQuaternionArray(atTime: t), sc = p.scales.float3Array(atTime: t)
    T.append(tr.flatMap { [$0.x, $0.y, $0.z] }); R.append(ro.flatMap { [$0.imag.x, $0.imag.y, $0.imag.z, $0.real] }); S.append(sc.flatMap { [$0.x, $0.y, $0.z] }) }
  // the skeleton prim's own world matrix per key: exporters (Sketchfab) leave the HIP as an animated Xform ABOVE the skeleton,
  // so the root's travel, bob and sway are here and not in any joint
  let X = times.map { m16(MDLTransform.globalTransform(with: skelObj!, atTime: $0)) }
  clips.append(["name": p.name, "joints": p.jointPaths, "times": times, "t": T, "r": R, "s": S, "world": X])
  print("clip", p.name, "joints", p.jointPaths.count, "keys", times.count, "t", times.first ?? 0, "→", times.last ?? 0) }
js["clips"] = clips
try! JSONSerialization.data(withJSONObject: js).write(to: out)
print("joints", paths.count, "→", out.path)
