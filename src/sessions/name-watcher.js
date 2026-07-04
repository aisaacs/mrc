// #52/#14: the retry + anti-hang core of the background name-watcher, extracted from mrc.js so it's unit-testable
// (inject generateName / statSync / sleep). generateName(uuid) returns a STATUS: 'named'/'exists'/'no-key' are
// TERMINAL; 'too-short'/'error' are RETRYABLE.
export function makeNamer({ generateName, statSync, jsonlPath, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // Retry generateName until a TERMINAL status. The in-session watcher passes Infinity (it's a background task that
  // process.exit hard-kills at session end — see mrc.js); the post-exit fallbacks pass a small cap (transcript final).
  // Returns the terminal status, or 'gave-up' when a bounded caller exhausts maxAttempts (so a maxAttempts=3 caller
  // that keeps getting 'too-short' STOPS after 3, never spins).
  const nameUntilDone = async (uuid, maxAttempts = Infinity) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const r = await generateName(uuid).catch(() => 'error')
      if (r === 'named' || r === 'exists' || r === 'no-key') return r
      await sleep(Math.min(30000, 5000 * (attempt + 1)))   // 'too-short' costs no API call; backoff only paces the rare 'error'
    }
    return 'gave-up'
  }

  // Bounded wait for the pinned .jsonl to APPEAR, then unbounded poll to ~10KB, then nameUntilDone. Returns TRUE iff it
  // engaged the file; FALSE iff the file never appeared within fileAppearTries — the caller then falls through to the
  // heuristic (the real on-disk file). Today pinned id === the .jsonl basename by construction; the bound is the
  // backstop for a future Claude Code that stops honoring --session-id (the ONLY way false is reached).
  const nameWhenReady = async (uuid, { fileAppearTries = 24, growthTries = 60, sizeGate = 10240 } = {}) => {
    const file = jsonlPath(uuid)
    let appeared = false
    for (let i = 0; i < fileAppearTries; i++) {
      try { statSync(file); appeared = true; break } catch {}
      await sleep(5000)
    }
    if (!appeared) return false
    // Poll toward ~10KB (enough OWN content to name well) but BOUNDED (Pierre): on timeout, name ANYWAY. This keeps
    // the pre-#14 "a long-lived SMALL session still gets named IN-session, not only post-exit" — the 200-char floor in
    // generateName still leaves a truly-thin (pure-consult) session unnamed. Reaching the gate early names it sooner.
    for (let j = 0; j < growthTries; j++) {
      let size = 0
      try { size = statSync(file).size } catch {}
      if (size >= sizeGate) break
      await sleep(5000)
    }
    await nameUntilDone(uuid)
    return true
  }

  return { nameUntilDone, nameWhenReady }
}
