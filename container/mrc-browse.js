#!/usr/bin/env node
// mrc-browse <url> — load a page in headless Chromium and report what a tester needs: HTTP status,
// title, a visible-text snippet, console/page errors, and a full-page screenshot saved under
// /workspace/.mrc/screenshots/. Lets a team member verify its own web/game output (testing hits
// localhost, which the firewall doesn't restrict).
//
// Playwright is installed globally; ESM `import` ignores NODE_PATH, so resolve it via createRequire
// from the global modules dir (same trick the channel server uses for the MCP SDK).
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire('/usr/local/lib/node_modules/.mrc-browse.js')
let chromium
try { ({ chromium } = require('playwright')) } catch { console.error('playwright is not installed in this image — rebuild it (docker rmi mister-claude).'); process.exit(2) }

const url = process.argv[2]
if (!url) { console.error('usage: mrc-browse <url>   (e.g. mrc-browse http://localhost:3000)'); process.exit(2) }

const dir = '/workspace/.mrc/screenshots'
mkdirSync(dir, { recursive: true })
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
try {
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
  const title = await page.title().catch(() => '')
  const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)
  const shot = join(dir, `shot-${Date.now()}.png`)
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
  console.log(`status: ${resp ? resp.status() : '(no response)'}`)
  console.log(`title: ${title}`)
  console.log(`screenshot: ${shot}`)
  console.log(`text: ${text}`)
  console.log(errors.length ? `errors:\n  ${errors.join('\n  ')}` : 'errors: none')
} catch (e) {
  console.log(`load failed: ${e.message}`)
  if (errors.length) console.log('  ' + errors.join('\n  '))
} finally {
  await browser.close().catch(() => {})
}
