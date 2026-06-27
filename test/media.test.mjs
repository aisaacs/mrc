// Unit tests for the media-generation members. The HTTP calls use an injected fetch, so dispatch,
// prompt extraction, and file-writing are exercised offline (no keys/network).
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { isMediaRole, mediaPrompt, generateImage, generateMedia } from '../src/teams/media.js'

test('isMediaRole covers the three makers, not the coders', () => {
  for (const r of ['designer', 'sound-designer', 'composer']) assert.ok(isMediaRole(r))
  for (const r of ['engineer', 'architect', 'critic']) assert.ok(!isMediaRole(r))
})

test('mediaPrompt strips @mentions and [Human …] framing into a clean description', () => {
  const p = mediaPrompt([
    { fromHandle: 'roland/claude', text: '@vespa make a pixel-art sprite of Dark Helmet' },
    { directive: true, text: '[Human directive]: 64x64, transparent background' },
  ])
  assert.ok(!p.includes('@vespa'))
  assert.ok(!/\[Human/.test(p))
  assert.match(p, /pixel-art sprite of Dark Helmet/)
  assert.match(p, /64x64/)
})

test('generateImage parses Gemini inlineData into image bytes', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } }] } }],
  }) })
  const r = await generateImage('a spaceball', { apiKey: 'k', fetchFn: fakeFetch })
  assert.equal(r.ext, 'png')
  assert.equal(r.bytes.toString(), 'PNGDATA')
})

test('generateImage surfaces a clear error on a missing key (no throw escaping generateMedia)', async () => {
  await assert.rejects(() => generateImage('x', { apiKey: '' }), /GEMINI_API_KEY is not set/)
})

test('generateMedia writes the asset into the territory and reports the path', async () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-media-'))
  process.env.GEMINI_API_KEY = 'test-key'
  const fakeFetch = async () => ({ ok: true, json: async () => ({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('IMG').toString('base64') } }] } }],
  }) })
  const member = { role: 'designer', repo, territory: 'assets', first: 'Vespa' }
  const out = await generateMedia(member, { items: [{ fromHandle: 'roland/claude', text: '@vespa make a sprite of a helmet' }], fetchFn: fakeFetch })
  assert.match(out.text, /Generated image: `assets\//)
  const files = fs.readdirSync(join(repo, 'assets'))
  assert.equal(files.length, 1)
  assert.match(files[0], /\.png$/)
  assert.equal(fs.readFileSync(join(repo, 'assets', files[0]), 'utf8'), 'IMG')
})

test('generateMedia fails gracefully (never throws) when the API errors', async () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-media-'))
  process.env.GEMINI_API_KEY = 'test-key'
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
  const member = { role: 'designer', repo, territory: 'assets', first: 'Vespa' }
  const out = await generateMedia(member, { items: [{ text: 'make art' }], fetchFn: fakeFetch })
  assert.match(out.text, /couldn't generate it: Gemini 429/)
})
