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
}
