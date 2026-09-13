import Foundation
import ModelIO
import CoreGraphics
import ImageIO
import simd
let url = URL(fileURLWithPath: CommandLine.arguments[1]), texDir = CommandLine.arguments[2]
let asset = MDLAsset(url: url)
// textures: material name -> RGBA bitmap
var tex: [String: (w: Int, h: Int, px: [UInt8])] = [:]
func loadTex(_ name: String, _ file: String) {
  let u = URL(fileURLWithPath: texDir + "/" + file)
  guard let src = CGImageSourceCreateWithURL(u as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("no tex", file); return }
  let w = img.width, h = img.height; var px = [UInt8](repeating: 0, count: w * h * 4)
  let cs = CGColorSpaceCreateDeviceRGB()
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h)); tex[name] = (w, h, px)
}
loadTex("M_AncientRuins_Props", "M_AncientRuins_Props_baseColor.jpg"); loadTex("M_AncientRuins_Rocks", "M_AncientRuins_Rocks_baseColor.jpg"); loadTex("M_AncientRuins_Plants", "M_AncientRuins_Plants_baseColor.png")
func sample(_ mat: String, _ u: Float, _ v: Float) -> (Int, Int, Int, Int) {
  guard let t = tex[mat] else { return (200, 200, 200, 255) }
  let x = min(t.w - 1, max(0, Int((u - floor(u)) * Float(t.w)))), y = min(t.h - 1, max(0, Int((1 - (v - floor(v))) * Float(t.h))))
  let i = (y * t.w + x) * 4; return (Int(t.px[i]), Int(t.px[i + 1]), Int(t.px[i + 2]), Int(t.px[i + 3]))
}
var out: [[String: Any]] = []
func walk(_ o: MDLObject, _ parent: simd_float4x4) {
  let local = o.transform?.matrix ?? matrix_identity_float4x4
  let world = parent * local
  if let m = o as? MDLMesh, let subs = m.submeshes as? [MDLSubmesh] {
    let vd = m.vertexDescriptor
    func attr(_ name: String) -> (MDLVertexAttributeData)? { return m.vertexAttributeData(forAttributeNamed: name) }
    guard let pa = attr(MDLVertexAttributePosition) else { return }
    let ta = attr(MDLVertexAttributeTextureCoordinate)
    var pos: [Float] = [], uv: [Float] = []
    for i in 0..<m.vertexCount {
      let p = pa.dataStart.advanced(by: i * pa.stride).assumingMemoryBound(to: Float.self)
      let w = world * SIMD4<Float>(p[0], p[1], p[2], 1); pos += [w.x, w.y, w.z]
      if let ta = ta { let t = ta.dataStart.advanced(by: i * ta.stride).assumingMemoryBound(to: Float.self); uv += [t[0], t[1]] } else { uv += [0, 0] }
    }
    for s in subs {
      let ib = s.indexBuffer.map(); var idx: [Int] = []
      let n = s.indexCount
      switch s.indexType { case .uInt16: let p = ib.bytes.assumingMemoryBound(to: UInt16.self); for i in 0..<n { idx.append(Int(p[i])) }
        case .uInt32: let p = ib.bytes.assumingMemoryBound(to: UInt32.self); for i in 0..<n { idx.append(Int(p[i])) }
        case .uInt8: let p = ib.bytes.assumingMemoryBound(to: UInt8.self); for i in 0..<n { idx.append(Int(p[i])) }
        default: break }
      let mat = s.material?.name ?? "-"
      var col: [Int] = []
      for i in 0..<m.vertexCount { let c = sample(mat, uv[i * 2], uv[i * 2 + 1]); col += [c.0, c.1, c.2, c.3] }
      out.append(["name": o.name, "mat": mat, "n": m.vertexCount, "pos": pos.map { Double(String(format: "%.2f", $0))! }, "uv": uv.map { Double(String(format: "%.4f", $0))! }, "idx": idx, "col": col])
    }
  }
  for c in o.children.objects { walk(c, world) }
}
for i in 0..<asset.count { walk(asset.object(at: i), matrix_identity_float4x4) }
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
print("meshes", out.count, "bytes", data.count)
