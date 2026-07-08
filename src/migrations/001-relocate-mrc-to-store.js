// Migration #001 — relocate a repo's `.mrc` memory into the host store slice. RELOCATION-ONLY (layoutLevel 0,
// layout-neutral: any store-capable image reads the relocated slice fine) and IRREVERSIBLE (down: null). Wraps the
// existing non-destructive migrateToStore; adds an explicit, BYTE-HONEST verify(). See docs/migration-system.md.
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { migrateToStore, normalizeSliceMtimes, planMigration } from '../mrc-store.js'

const sha256 = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex') } catch { return null } }
const transcripts = (dir) => { try { return readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return [] } }
const uuidOf = (f) => f.slice(0, -6)

export default {
  id: '001-relocate-mrc-to-store',
  description: "Relocate this repo's .mrc memory into the host store (memory lives outside the repo).",
  layoutLevel: 0,   // relocation-only, layout-NEUTRAL — any store-capable image reads the relocated slice
  down: null,       // IRREVERSIBLE — no honest reverse (slice→repo/.mrc re-opens the hostile-clone surface + makes
                    // memory travel on git-clone again; leaving the slice strands store-born content). `detach` opts out.

  // Pending if the repo actually has legacy memory to relocate.
  isPending(ctx) {
    const L = ctx.legacyDir
    if (!L || !existsSync(L)) return false
    return transcripts(L).length > 0 || existsSync(join(L, 'memory')) || existsSync(join(L, 'session-names'))
  },

  preview(ctx) {
    const L = ctx.legacyDir
    const inScope = (u) => ctx.include ? ctx.include.has(u) : !(ctx.exclude && ctx.exclude.has(u))
    const ts = transcripts(L).filter(f => inScope(uuidOf(f)))
    let bytes = 0; for (const f of ts) { try { bytes += statSync(join(L, f)).size } catch {} }
    return { conversations: ts.length, bytes, hasMemory: existsSync(join(L, 'memory')) }
  },

  // Idempotent (copy-if-absent + sentinel-last inside migrateToStore), non-destructive (repo/.mrc untouched).
  up(ctx) {
    const r = migrateToStore(ctx.legacyDir, ctx.sliceDir, { exclude: ctx.exclude, include: ctx.include })
    normalizeSliceMtimes(ctx.sliceDir, ctx.legacyDir)
    return r
  },

  // BYTE-HONEST verify over the SHARED enumeration (planMigration — the SAME set up() copied, so verify's scope can't
  // drift from up()'s allow-list, and it never follows/false-fails a refused symlink). Byte-walks the WHOLE migrated set
  // (transcripts + memory/ + session-summaries/ + <uuid>/ leaves), not just top-level transcripts, so a corrupt
  // memory/MEMORY.md can't green. legacy→slice ONLY (never slice→legacy — store-BORN files have no legacy source and
  // would false-fail on a re-run). A MISSING or DIFFERING file is a drop or a DIVERGENT SHARER (another working copy
  // shares this slice; its same-path-different-bytes was copy-if-absent-skipped) → FAIL, never a silent pass. The
  // manifest is taken from up()'s record when present (ctx.manifest), else re-derived via the SAME planMigration.
  verify(ctx) {
    const { legacyDir: L, sliceDir: S } = ctx
    const plan = Array.isArray(ctx.manifest) ? { manifest: ctx.manifest, refused: ctx.refused || [] } : planMigration(L, { exclude: ctx.exclude, include: ctx.include })
    const swapped = new Set(plan.refused.filter(r => r.reason === 'symlink-swapped').map(r => r.path))   // leaf that turned into a symlink DURING migration (slice changed underfoot)
    const checks = []; let pass = true, verified = 0
    for (const rel of plan.manifest) {
      const sf = join(S, rel)
      if (!existsSync(sf)) {
        pass = false
        checks.push(swapped.has(rel)
          ? { ok: false, kind: 'changed-underfoot', file: rel, msg: `${rel} was swapped to a symlink DURING migration — the slice changed underfoot; re-run \`mrc migrate\`` }
          : { ok: false, kind: 'missing', file: rel, msg: `${rel} is in repo/.mrc but NOT in the store — dropped, or another working copy shares this slice (divergent sharer)` })
        continue
      }
      if (sha256(join(L, rel)) !== sha256(sf)) { pass = false; checks.push({ ok: false, kind: 'differs', file: rel, msg: `${rel} bytes differ between repo/.mrc and the store (divergent sharer, or corruption)` }); continue }
      verified++
    }
    checks.unshift({ ok: pass, msg: `byte-verified ${verified}/${plan.manifest.length} migrated file(s) legacy↔store${pass ? '' : ' — INTEGRITY FAILURE (see below)'}` })
    return { pass, checks }
  },

  // ADOPTION gate (live-door finding, 2026-07-08). Byte-equality `verify` is the right check RIGHT AFTER a fresh
  // copy (slice == legacy by construction) — but WRONG for ADOPTING an already-migrated slice that has since been
  // USED: session-names grows, memory/ is edited, a continued conversation's transcript gets longer. Exact-equality
  // flags all that legitimate store-era evolution as "divergence" and would strand every actively-used repo (dietV2:
  // only session-names(superset) + names-migrated(marker) differ — no loss). So adoption uses LOSS-DETECTION, not
  // equality: the question is "did the slice LOSE any pre-migration content?", not "is it identical?".
  //   • transcript .jsonl : slice must exist AND legacy lines must be a PREFIX of slice lines (slice-AHEAD = lossless
  //     superset → OK). legacy-AHEAD (repo/.mrc grew under a later LEGACY launch) or FORKED (shared prefix then
  //     diverge) = a real split → FAIL → reconciler. MISSING = lost history → FAIL.
  //   • session-names / names-migrated / security-migrated : SET files — every legacy line must still be present in
  //     the slice (superset OK; a DROPPED entry = a lost name → FAIL). Order-independent.
  //   • memory/ + session-summaries/ + anything else living : present-and-edited is EXPECTED (the slice is
  //     authoritative, repo/.mrc is the frozen pre-migration snapshot, retained non-destructively). Present → OK;
  //     MISSING → FAIL (lost). Content divergence is surfaced as info, never a block.
  // A genuine split still routes to the reconciler; only benign evolution passes. Fresh-migrate keeps strict verify().
  verifyAdopt(ctx) {
    const { legacyDir: L, sliceDir: S } = ctx
    const plan = planMigration(L, { exclude: ctx.exclude, include: ctx.include })
    // session-names is a real SET of user data (uuid=name) that must not lose entries. names-migrated / security-migrated
    // are one-time STATE MARKERS whose content legitimately differs (a flag/version), so they get presence-only (the
    // living-file branch), NOT set-preservation — treating a marker as preservable data false-strands (dietV2's real case).
    const isSetFile = (rel) => rel === 'session-names'
    // split on \n then DROP trailing empties (the file-final newline yields a trailing '' that isn't a line) so a
    // legacy transcript that ends in \n is a clean prefix of a slice that continued past it.
    const readLines = (f) => { try { const a = readFileSync(f, 'utf8').split('\n'); while (a.length && a[a.length - 1] === '') a.pop(); return a } catch { return null } }
    const isPrefix = (a, b) => { if (!a || !b || a.length > b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }
    const checks = []; let pass = true, okCount = 0, evolved = 0
    for (const rel of plan.manifest) {
      const lf = join(L, rel), sf = join(S, rel)
      if (!existsSync(sf)) { pass = false; checks.push({ ok: false, kind: 'missing', file: rel, msg: `${rel} is in repo/.mrc but MISSING from the store — pre-migration content lost` }); continue }
      if (sha256(lf) === sha256(sf)) { okCount++; continue }                                     // identical → fine
      if (rel.endsWith('.jsonl')) {
        const la = readLines(lf), sa = readLines(sf)
        if (isPrefix(la, sa)) { okCount++; evolved++; continue }                                  // slice-AHEAD (lossless superset) → fine
        pass = false
        const kind = isPrefix(sa, la) ? 'legacy-ahead' : 'forked'
        checks.push({ ok: false, kind, file: rel, msg: `${rel} — repo/.mrc and the store have FORKED history (a legacy launch wrote after migration); needs the reconciler, not a blind adopt` })
        continue
      }
      if (isSetFile(rel)) {
        // session-names is `<uuid>=<name>`. Check per-KEY, NOT per-line (Pierre): a RENAME (<uuid>=old → <uuid>=new,
        // a first-class in-store op — there's a /rename skill) changes the VALUE, so per-line containment would
        // false-strand it as "lost." Every legacy KEY (uuid) must still be present as a key in the slice (value MAY
        // differ = rename, benign); a legacy key absent = a DROPPED name = FAIL. The transcript itself is verified
        // independently by the prefix rule, so accepting a metadata value change here is correct, not lax.
        const keyOf = (line) => { const i = line.indexOf('='); return i < 0 ? line : line.slice(0, i) }
        const sliceKeys = new Set((readLines(sf) || []).filter(Boolean).map(keyOf))
        const lost = (readLines(lf) || []).filter(Boolean).map(keyOf).filter(k => !sliceKeys.has(k))
        if (lost.length === 0) { okCount++; evolved++; continue }                                 // every legacy uuid still named (values may have changed) → fine
        pass = false
        checks.push({ ok: false, kind: 'entries-lost', file: rel, msg: `${rel} — ${lost.length} legacy session name(s) DROPPED from the store version (uuid no longer named)` })
        continue
      }
      // living file (memory/, session-summaries/, markers): present-and-edited is EXPECTED, not loss. But a SHRUNK
      // file could be a legitimate edit-down OR a truncation we can't prove apart — so don't fail (false-strand) and
      // don't silently pass (hides loss): SURFACE a non-blocking INFO (Pierre Q2). The retained repo/.mrc snapshot is
      // the concrete thing to diff against.
      okCount++; evolved++
      try { const ls = statSync(lf).size, ss = statSync(sf).size; if (ss < ls) checks.push({ ok: true, kind: 'shrank', file: rel, msg: `${rel} is smaller in the store (${ss}B) than at migration (${ls}B) — expected if you edited it down; check if unexpected (frozen copy in repo/.mrc)` }) } catch {}
    }
    checks.unshift({ ok: pass, kind: 'summary', msg: `adoption loss-check: ${okCount}/${plan.manifest.length} legacy file(s) present-and-not-lost (${evolved} evolved in-store)${pass ? '' : ' — POTENTIAL LOSS / FORK (see below)'}` })
    return { pass, checks }
  },
}
