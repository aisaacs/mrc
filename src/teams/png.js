// Minimal, dependency-free PNG codec + chroma-key — just enough to cut a solid background color out
// of a generated image into real alpha. Gemini can't emit a true alpha channel (it paints a fake
// transparency checkerboard), so the designer asks for a solid magenta background and we remove it
// here. Handles 8-bit RGB/RGBA, non-interlaced PNGs (what image models return); throws on anything
// else so callers can fall back to the original bytes.
import zlib from 'node:zlib'

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }

// PNG -> { width, height, data:Uint8Array(RGBA) }
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)')
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const rb = raw[p++]
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v
      switch (filter) {
        case 0: v = rb; break
        case 1: v = rb + a; break
        case 2: v = rb + b; break
        case 3: v = rb + ((a + b) >> 1); break
        case 4: v = rb + paeth(a, b, c); break
        default: throw new Error('bad PNG filter ' + filter)
      }
      cur[x] = v & 0xFF
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp, di = (y * width + x) * 4
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
    prev = cur
  }
  return { width, height, data: out }
}

// RGBA -> PNG (8-bit RGBA, filter 0). Small images (sprites/icons), so simple beats clever.
export function encodePNG(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const ro = y * (stride + 1)
    raw[ro] = 0
    for (let x = 0; x < stride; x++) raw[ro + 1 + x] = rgba[y * stride + x]
  }
  const idat = zlib.deflateSync(raw)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6   // 8-bit RGBA
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// Make pixels within `tol` (Euclidean RGB distance) of the background color fully transparent.
export function chromaKey(pngBuf, { r, g, b }, tol = 70) {
  const { width, height, data } = decodePNG(pngBuf)
  const tol2 = tol * tol
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b
    if (dr * dr + dg * dg + db * db <= tol2) data[i + 3] = 0
  }
  return encodePNG(width, height, data)
}
