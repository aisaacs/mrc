// Tests for the dependency-free PNG codec + chroma-key used to cut a solid background to real alpha.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePNG, encodePNG, chromaKey } from '../src/teams/png.js'

test('png round-trips RGBA pixels exactly', () => {
  const w = 3, h = 2
  const rgba = new Uint8Array([
    255, 0, 255, 255, 10, 20, 30, 255, 0, 0, 0, 255,
    100, 150, 200, 128, 1, 2, 3, 4, 250, 240, 230, 220,
  ])
  const dec = decodePNG(encodePNG(w, h, rgba))
  assert.equal(dec.width, 3); assert.equal(dec.height, 2)
  assert.deepEqual([...dec.data], [...rgba])
})

test('chromaKey makes the background color transparent and leaves the subject opaque', () => {
  const w = 2, h = 1
  const rgba = new Uint8Array([255, 0, 255, 255 /* magenta bg */, 12, 200, 60, 255 /* subject */])
  const dec = decodePNG(chromaKey(encodePNG(w, h, rgba), { r: 255, g: 0, b: 255 }, 40))
  assert.equal(dec.data[3], 0, 'magenta -> alpha 0')
  assert.equal(dec.data[7], 255, 'subject pixel kept opaque')
  assert.deepEqual([...dec.data.slice(4, 7)], [12, 200, 60], 'subject color unchanged')
})

test('chromaKey tolerance catches near-matches (anti-aliased background)', () => {
  const w = 1, h = 1
  const rgba = new Uint8Array([250, 8, 248, 255]) // slightly-off magenta
  const dec = decodePNG(chromaKey(encodePNG(w, h, rgba), { r: 255, g: 0, b: 255 }, 30))
  assert.equal(dec.data[3], 0, 'near-magenta within tolerance -> transparent')
})

test('decodePNG rejects formats it cannot handle (caller falls back)', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /not a PNG/)
})
