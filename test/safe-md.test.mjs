// #63-A: adversarial tests for the shared safe-Markdown renderer (the single audited member-text→HTML path).
// Mirrors Ghislaine's six attack classes + Roland's correctness gates: escape-first, href allowlist+normalize,
// fixed-tags / zero member attributes, code+lang escaped, balanced output, ReDoS-linearity, no chrome forgery.
import test from 'node:test'
import assert from 'node:assert/strict'
import { esc, safeMD } from '../src/safe-md.js'

const NUL = String.fromCharCode(0)

test('#63-A esc: escapes the five HTML-significant chars; idempotent on already-safe text', () => {
  assert.equal(esc(`<img src=x onerror=alert(1)>`), '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(esc(`a & b "c" 'd'`), 'a &amp; b &quot;c&quot; &#39;d&#39;')
  assert.equal(esc(null), ''); assert.equal(esc(undefined), '')
})

// CLASS 1 — raw HTML / XSS must render INERT (escape-first). No live tag may survive.
test('#63-A class1: raw HTML / script / svg / iframe / comment / breakout all neutralized', () => {
  for (const p of [
    `<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `<svg onload=alert(1)>`,
    `<iframe src=javascript:alert(1)>`, `<style>*{}</style>`, `<!-- x -->`, `</div><img onerror=1>`,
    `<textarea></textarea>`, `<noscript></noscript>`, `<xmp></xmp>`,
  ]) {
    const out = safeMD(p)
    assert.ok(!/<(img|script|svg|iframe|style|textarea|noscript|xmp|!--)/i.test(out), `live tag survived: ${p} -> ${out}`)
    assert.ok(out.includes('&lt;'), `not escaped: ${p} -> ${out}`)
  }
  // MD images are NOT a feature → no <img> ever
  assert.ok(!/<img/i.test(safeMD('![alt](http://x/a.png)')))
})

// CLASS 2 — href smuggling: disallowed schemes blocked (incl. obfuscations); allowed url is attribute-escaped.
test('#63-A class2: link scheme allowlist + normalization + attribute-escape', () => {
  const noAnchor = (md) => { const o = safeMD(md); assert.ok(!/<a\b/i.test(o), `unexpected anchor: ${md} -> ${o}`) }
  noAnchor('[x](javascript:alert(1))')
  noAnchor('[x](JaVaScRiPt:alert(1))')
  noAnchor('[x]( javascript:alert(1))')
  noAnchor(`[x](java${String.fromCharCode(9)}script:alert(1))`)   // embedded TAB
  noAnchor(`[x](java${String.fromCharCode(10)}script:alert(1))`)  // embedded newline (won't match link anyway, but never an anchor)
  noAnchor('[x](data:text/html,<script>alert(1)</script>)')
  noAnchor('[x](vbscript:msgbox(1))')
  noAnchor('[x](javascript&colon;alert(1))')                      // &-encoded colon → escape-first neutralizes
  // allowed schemes DO link
  for (const u of ['http://example.com/a', 'https://example.com/a?b=1', 'mailto:a@b.com']) {
    const o = safeMD(`[ok](${u})`)
    assert.match(o, /<a class="md-link" href="[^"]*" rel="noopener noreferrer" target="_blank">ok<\/a>/)
  }
  // attribute breakout via an ALLOWED scheme (no space — a space would just break the MD link syntax): the
  // `"` is escaped to &quot;, so it stays INSIDE the href value and the anchor has EXACTLY its fixed
  // attributes — no injected onX. Asserting the whole open tag proves no extra attribute slipped in.
  assert.match(safeMD('[x](http://a"onmouseover=alert(1))'),
    /<a class="md-link" href="[^"]*" rel="noopener noreferrer" target="_blank">x<\/a>/)
  // and a space in the url → not linked at all (inert), still no breakout
  assert.ok(!/onmouseover="alert/.test(safeMD('[x](http://a" onmouseover="alert(1))')))
})

// CLASS 3 — code-block breakout + language-tag injection.
test('#63-A class3: fenced/inline code content + lang tag are escaped, no breakout', () => {
  const fenced = safeMD('```\n</code></pre><img src=x onerror=alert(1)>\n```')
  assert.ok(/<pre class="md-pre"><code>/.test(fenced) && /<\/code><\/pre>/.test(fenced))
  assert.ok(!/<img/i.test(fenced) && fenced.includes('&lt;'), `code breakout: ${fenced}`)
  // language tag must NOT land in an attribute unescaped
  const lang = safeMD('```"><img src=x onerror=alert(1)>\ncode\n```')
  assert.ok(!/<img/i.test(lang), `lang injection: ${lang}`)
  assert.ok(!/class="language-/.test(lang), 'no language- class emitted (lang discarded)')
  const inline = safeMD('`</code><img src=x onerror=1>`')
  assert.ok(!/<img/i.test(inline) && /<code class="md-code">/.test(inline), `inline code breakout: ${inline}`)
})

// CLASS 4 — no chrome forgery: a member writing chrome-looking text in its BODY renders inert.
test('#63-A class4: body text can never forge the trusted chrome (chip/directive/jump)', () => {
  for (const p of ['[#7]', '(re #7)', 'see ⦉quoted “Human directive”⦊:', '**Human directive**', '[#7](#q7)']) {
    const o = safeMD(p)
    assert.ok(!/class="(qnum|qjump|directive|ref)"/.test(o), `forged chrome class: ${p} -> ${o}`)
    assert.ok(!/\bid="q\d/.test(o) && !/onclick=/.test(o), `forged id/onclick: ${p} -> ${o}`)
  }
  // a markdown link never gets a chrome class — only the generic md-link
  const lnk = safeMD('[#7](http://x)')
  assert.ok(/class="md-link"/.test(lnk) && !/qnum|qjump|directive/.test(lnk))
})

// CLASS 5 — balanced output (the belt-and-suspenders canary; the real boundary is DOM-append at the caller).
test('#63-A class5: unterminated emphasis/link/fence emit NO dangling tag (balanced output)', () => {
  for (const p of ['**unclosed bold', 'a *dangling', '[text](http://x', '`unclosed code', '```\nunclosed fence', 'a [b](c) **x']) {
    const o = safeMD(p)
    const opens = (o.match(/<(strong|em|a|code|pre|ul|ol|li)\b/g) || []).length
    const closes = (o.match(/<\/(strong|em|a|code|pre|ul|ol|li)>/g) || []).length
    assert.equal(opens, closes, `unbalanced (${opens}/${closes}): ${p} -> ${o}`)
  }
})

// CLASS 6 — ReDoS / pathological input must return quickly and bounded.
test('#63-A class6: pathological input is bounded (length cap) and fast', () => {
  const big = '['.repeat(50000) + '*'.repeat(50000) + ']'.repeat(50000)
  const t0 = Date.now(); const o = safeMD(big); const dt = Date.now() - t0
  assert.ok(dt < 1000, `too slow (${dt}ms) — possible ReDoS`)
  assert.ok(o.length < 9000, `output not length-bounded: ${o.length}`)
  assert.ok(o.endsWith('…'), 'capped input gets the truncation marker')
})

// Positive: the happy-path subset renders as expected (and stays inert where it must).
test('#63-A: valid markdown renders to the small safe subset', () => {
  assert.match(safeMD('**bold**'), /^<strong>bold<\/strong>$/)
  assert.match(safeMD('a *it* b'), /a <em>it<\/em> b/)
  assert.match(safeMD('use `code` here'), /use <code class="md-code">code<\/code> here/)
  assert.match(safeMD('line1\nline2'), /line1<br>line2/)
  const list = safeMD('- a\n- b')
  assert.match(list, /<ul class="md-list"><li>a<\/li><li>b<\/li><\/ul>/)
  const ol = safeMD('1. a\n2. b')
  assert.match(ol, /<ol class="md-list"><li>a<\/li><li>b<\/li><\/ol>/)
})

// The NUL sentinel cannot be smuggled (input NULs are stripped before stashing).
test('#63-A: a member-supplied NUL cannot capture a code slot', () => {
  const o = safeMD(`${NUL}0${NUL} and \`real\``)
  assert.ok(/<code class="md-code">real<\/code>/.test(o), `code lost: ${o}`)
  assert.ok(!o.includes(NUL), 'no raw NUL in output')
})
