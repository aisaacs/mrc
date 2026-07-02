import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * Extract a condensed transcript from a session JSONL.
 * If maxChars > 0, stop once that length is reached.
 * Otherwise cap at ~16K chars (first 8K + last 8K).
 *
 * `excludeMeta` (#48): drop system-injected user turns — room/channel peer messages, the
 * `--continue` resume marker, local-command caveats. Claude Code flags every one of these
 * `isMeta` (and a peer delivery is additionally `<channel source=...>`-prefixed); a human's own
 * typed prompt is never isMeta. Naming passes this so a *consulted* session (one a peer opened a
 * room with and fed a prompt) gets named from its OWN input, not the peer's topic — which is often
 * the asking session's very name. Summaries leave it off, so a summary still reflects a consultation.
 */
export function extractTranscript(mrcDir, uuid, maxChars = 0, { excludeMeta = false } = {}) {
  const file = join(mrcDir, `${uuid}.jsonl`)
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return '' }

  const lines = []
  let total = 0
  // #48/OBJ-4: `metaContext` = was the LAST user turn injected (a room/channel peer ask)? If so, the ASSISTANT
  // reply that follows is about the PEER's topic, not this session's own work — so it's skipped too. A human's
  // own typed prompt is never isMeta, so it clears the context and its assistant turns count. Without this, a
  // consulted session was still named from its replies-to-the-peer (only the injected USER ask was dropped).
  let metaContext = false

  for (const rawLine of raw.split('\n')) {
    if (!rawLine) continue
    let obj
    try { obj = JSON.parse(rawLine) } catch { continue }

    if (obj.type === 'user') {
      let content = obj.message?.content || ''
      if (Array.isArray(content)) {
        content = content.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
      }
      // #48: skip injected turns. isMeta is Claude Code's flag for not-human-typed input; the `<channel` prefix
      // is a belt-and-suspenders guard in case a build stops setting isMeta on channel deliveries. Track whether
      // this user turn is injected so the following assistant reply (about the peer's topic) is skipped too.
      const isChannelTurn = typeof content === 'string' && /^\s*<channel\b/.test(content)
      // #48 OBJ-C: structural recognizers for the OTHER injected user turns the doc promises to drop — the
      // `--continue` resume marker and local-command caveats / slash-command wrappers. The `<channel` guard already
      // hedges a build that stops setting isMeta on channel deliveries; extend the SAME hedge to these two so if CC
      // ever drops isMeta on one of them it still isn't mistaken for the human retaking the floor (which would clear
      // metaContext mid-consult → leak the peer's topic into the name). Anchored to the exact injected prefixes so a
      // human's own prose (which never starts with these tags) isn't misclassified as meta and dropped.
      const isInjectedTurn = isChannelTurn || (typeof content === 'string' && (
        /^\s*<(local-)?command-[a-z-]+>/.test(content) ||                             // <command-name>/<command-message>/<local-command-caveat>/… — require the WELL-FORMED tag close so a human's prose ("<command-line interface is great") isn't cosmetically dropped (the belt overrides isMeta:false, so an open `<command-` prefix would eat any turn starting that way). Assumes bare tags (true today); revisit if CC ever attributes them.
        /^\s*This session is being continued from a previous conversation/.test(content)  // the --continue / compaction resume marker (a full sentence — negligible human collision, left as a prefix)
      ))
      const isMetaTurn = obj.isMeta === true || isInjectedTurn
      // metaContext is STICKY: a peer ask (<channel>) sets it; ONLY a genuine human prompt (non-meta AND non-empty)
      // clears it. Everything else leaves it UNCHANGED — crucially a TOOL_RESULT, which is ALSO a type:'user' turn
      // (isMeta:false, an array of tool_result blocks → empty after the text filter above). A tool result is not
      // the human taking the floor back, so it must not reset "we're answering a peer", or the assistant turns
      // AFTER it (the rest of the reply — every tool-using consultation) would leak the peer's topic to the namer.
      if (excludeMeta) {
        if (isChannelTurn) metaContext = true
        else if (!isMetaTurn && content.trim()) metaContext = false
      }
      if (excludeMeta && isMetaTurn) continue
      if (content.trim()) {
        const line = `USER: ${content.trim()}`
        lines.push(line)
        total += line.length
      }
    } else if (obj.type === 'assistant') {
      // #48/OBJ-4: an assistant turn replying to an injected user turn is ABOUT THE PEER's topic — skip it so a
      // consulted session isn't named from its own replies. (metaContext resets on the human's next real prompt.)
      if (excludeMeta && metaContext) continue
      const content = obj.message?.content
      if (typeof content === 'string') {
        const line = `ASSISTANT: ${content.trim()}`
        lines.push(line)
        total += line.length
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            const line = `ASSISTANT: ${block.text.trim()}`
            lines.push(line)
            total += line.length
          } else if (block.type === 'tool_use') {
            const name = block.name || '?'
            const inp = block.input || {}
            let detail
            if (name === 'Bash') detail = (inp.command || '').slice(0, 80)
            else if (['Grep', 'Glob'].includes(name)) detail = (inp.pattern || '').slice(0, 80)
            else if (['Read', 'Write', 'Edit'].includes(name)) detail = (inp.file_path || '').slice(0, 80)
            else detail = JSON.stringify(inp).slice(0, 80)
            const line = `TOOL: ${name}(${detail})`
            lines.push(line)
            total += line.length
          }
        }
      }
    }

    if (maxChars > 0 && total >= maxChars) break
  }

  let transcript = lines.join('\n')
  if (maxChars > 0) return transcript.slice(0, maxChars)
  if (transcript.length > 16000) {
    transcript = transcript.slice(0, 8000) + '\n\n[... middle truncated ...]\n\n' + transcript.slice(-8000)
  }
  return transcript
}

/** Regex patterns for tool-miss detection. */
const TOOL_MISS_PATTERNS = [
  [/(\S+): command not found/g, 'command not found'],
  [/bash: (\S+): No such file or directory/g, 'not on PATH'],
  [/(?:illegal|invalid|unrecognized) option/g, 'option incompatibility'],
]

/** Detect missing tools from a session transcript. Returns Map<cmd, desc>. */
export function detectToolMisses(mrcDir, uuid) {
  const file = join(mrcDir, `${uuid}.jsonl`)
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return new Map() }

  const misses = new Map()
  for (const rawLine of raw.split('\n')) {
    if (!rawLine) continue
    let obj
    try { obj = JSON.parse(rawLine) } catch { continue }
    let content = obj.message?.content || ''
    if (Array.isArray(content)) {
      content = content.filter(c => typeof c === 'object').map(c => c.text || '').join('\n')
    }
    for (const [pattern, desc] of TOOL_MISS_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(content)) !== null) {
        const cmd = match[1] || match[0]
        if (cmd && cmd !== '.' && cmd !== '..') misses.set(cmd, desc)
      }
    }
  }
  return misses
}
