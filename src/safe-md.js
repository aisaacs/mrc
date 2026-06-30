// #63-A: the SINGLE audited safe-Markdown renderer + HTML escaper. One hardened path shared by every site
// that displays UNTRUSTED member-controlled text (the room transcript, the @you channel, #64 session names).
//
// THE CARDINAL RULE: escape ALL HTML first, THEN apply allowlisted transforms to the already-inert text.
// Never transform-then-escape, never a denylist. Because the base text is escaped before any transform runs,
// even a buggy transform cannot introduce live markup — at worst it emits a wrong-but-inert string.
//
// Constraints (all enforced below):
//  • NO raw-HTML passthrough, NO <img> (no remote-load / onerror exfil), NO tables, NO member-controlled
//    attributes — transforms emit FIXED tags; the ONLY body-derived attribute is an allowlisted+escaped href.
//  • href: http/https/mailto ONLY, scheme tested on a NORMALIZED value (strip control/space anywhere in the
//    scheme region + lowercase) so " javascript:" / "java<TAB>script:" / "JaVaScRiPt:" can't slip through;
//    the escape-first pass already neutralizes &-entity-encoded schemes.
//  • BALANCED output — every transform fires only on a COMPLETE delimiter pair, so output is well-formed.
//    (The trust boundary does NOT rest on this: the caller renders this body into its own <div class="body">
//    and DOM-APPENDS the trusted chrome as sibling nodes, so chrome can never be captured by the body string.
//    Balanced output is a quality canary on top.)
//  • NEVER emits the trusted CHROME (the [#N] chip / directive / jump classes or an id/onclick) — a member
//    writing "[#7]", the directive guillemets, or "**Human directive**" in its body is inert escaped text.
//  • ReDoS-bounded: input is length-capped and every pattern is linear (negated char classes, complete pairs).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
// Escape HTML-special chars. The first pass of safeMD AND the standalone escaper for any single member-
// controlled string placed into markup (e.g. #64 session names). The one hardened escaper — no re-impl.
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c])

const MAX_LEN = 8000                                  // input cap → bounds pathological backtracking cost
// Private code-slot sentinel = NUL. Built via fromCharCode so the SOURCE stays pure ASCII (NUL only exists
// at runtime). Input NULs are stripped first, so a member can never smuggle a sentinel to capture a slot.
const NUL = String.fromCharCode(0)
const NUL_RE = new RegExp(NUL, 'g')
const SLOT_RE = new RegExp(NUL + '(\\d+)' + NUL, 'g')
// All control + space chars (0x00..0x20) — stripped from a url before the scheme test so embedded
// tab/newline/NUL/leading-space can't hide a disallowed scheme.
const CTRL_WS_RE = new RegExp('[' + NUL + '-' + String.fromCharCode(0x20) + ']+', 'g')

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])
// Link ONLY a URL with an EXPLICIT allowed scheme (http/https/mailto). `escapedUrl` is already HTML-escaped
// (safeMD escapes first), so it's safe inside href="..."; this adds the SCHEME gate. Normalize before the
// test: strip every control/space char (anywhere — defeats "java<TAB>script:" and " javascript:") + lowercase
// (defeats "JaVaScRiPt:"). Requiring an explicit allowed scheme (rather than allowing schemeless/relative)
// also rejects protocol-relative "//host", bare relatives (meaningless in a chat message), and entity-smuggled
// schemes like "javascript&colon;" (no real ":" → no scheme match → not linked). Returns the escaped url, or
// null → the caller leaves the literal "[text](url)" as inert text.
function safeHref(escapedUrl) {
  const probe = escapedUrl.replace(CTRL_WS_RE, '').toLowerCase()
  const m = probe.match(/^([a-z][a-z0-9+.\-]*):/)                 // a leading scheme, if any
  return (m && ALLOWED_SCHEMES.has(m[1])) ? escapedUrl : null
}

// Convert consecutive `- ` / `* ` (ul) or `N. ` (ol) lines into one balanced list. Operates on already-
// escaped, code-stashed text; list blocks carry NO internal newlines so the later <br> pass skips them.
function renderLists(s) {
  const lines = s.split('\n'); const out = []; let open = null    // 'ul' | 'ol' | null
  const close = () => { if (open) { out[out.length - 1] += `</${open}>`; open = null } }
  for (const line of lines) {
    const ul = line.match(/^[ \t]*[-*][ \t]+(.+)$/)
    const ol = line.match(/^[ \t]*\d{1,9}\.[ \t]+(.+)$/)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol', item = (ul || ol)[1]
      if (open && open !== want) close()
      if (!open) { out.push(`<${want} class="md-list"><li>${item}</li>`); open = want }
      else { out[out.length - 1] += `<li>${item}</li>` }
    } else { close(); out.push(line) }
  }
  close()
  return out.join('\n')
}

// Render a SMALL safe Markdown subset to HTML: bold, italic, inline + fenced code, http(s)/mailto links,
// lists, line breaks. Everything else is inert escaped text. Returns balanced, attribute-disciplined HTML.
export function safeMD(input) {
  let s = String(input == null ? '' : input).replace(NUL_RE, '')      // (0) drop NULs (our slot sentinel)
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…'
  s = esc(s)                                                            // (1) ESCAPE EVERYTHING — rest transforms inert text

  // (2) Stash code spans BEFORE other transforms (so **/_/[ ] inside code stay literal). Content is already
  //     escaped; the fenced lang tag is DISCARDED (never emitted → no class="language-<lang>" injection).
  const slots = []
  const stash = (html) => NUL + (slots.push(html) - 1) + NUL
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => stash(`<pre class="md-pre"><code>${body}</code></pre>`))
  s = s.replace(/`([^`\n]+)`/g, (_, body) => stash(`<code class="md-code">${body}</code>`))

  // (3) Links [text](url): allowlisted+escaped href, escaped text, GENERIC class only (never chrome). A
  //     disallowed scheme leaves the literal (inert) `[text](url)` — no anchor.
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m0, text, url) => {
    const href = safeHref(url)
    return href ? `<a class="md-link" href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>` : m0
  })

  // (4) Bold (** / __) before italic (* / _), each only on a complete same-line pair → balanced output.
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^\n]+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, '$1<em>$2</em>')

  // (5) Lists, then (6) remaining newlines → <br> (code blocks are stashed, so their newlines are untouched);
  //     strip a <br> directly adjacent to a list/pre boundary so block elements don't gain stray blank lines.
  s = renderLists(s)
  s = s.replace(/\n/g, '<br>')
  s = s.replace(/<br>(\s*<(?:ul|ol|pre)\b)/g, '$1').replace(/(<\/(?:ul|ol|pre)>)\s*<br>/g, '$1')

  // (7) Restore the stashed code spans verbatim.
  return s.replace(SLOT_RE, (_, i) => slots[Number(i)])
}
