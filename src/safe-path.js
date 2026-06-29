// Shared asset-path security primitive — the SINGLE audited implementation imported by both the dashboard
// HTTP surface (rooms-dashboard.js /api/asset) and the room daemon (#56 send_photo → Telegram). A security
// primitive must have ONE source of truth; two copies drift and one gets a fix the other misses. The
// containment ROOT is a parameter: the dashboard passes the repo; #56 passes the repo too and then ADDS a
// territory-subtree assertion on the resolved realpath (the threat is higher — an untrusted agent pushing
// a file to an EXTERNAL service vs a human reading their own repo over localhost — so #56 tightens the root
// with a second check rather than loosening this primitive).
import { realpathSync, statSync } from 'node:fs'
import { join, sep, extname } from 'node:path'

// #48b/#48c: media content-types served by /api/asset. RASTER images + mp3 audio ONLY — no svg (it can
// carry script → XSS if ever rendered outside an <img>); the list mirrors exactly what media.js emits
// (Gemini → png/jpg, ElevenLabs sfx/music → mp3), so there's no extension here without a producer.
export const ASSET_CONTENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg' }

// Resolve `rel` to a real file INSIDE `repo`, or null if it's unsafe / escapes. THE guard for /api/asset
// (it serves file bytes — the highest-risk endpoint). Reject absolute / NUL / `..` BEFORE touching the fs,
// then realpathSync the FINAL file + the repo and require containment with a trailing path.sep — a bare
// startsWith would let a sibling-prefix dir (`<repo>-secret/x.png`) pass. realpath-on-the-final-file
// defeats both `..` traversal and symlink-escape. (The query param is decoded exactly ONCE by
// URLSearchParams, so `%252e` games stay literal and fail the realpath lookup.)
export function safeAssetPath(repo, rel) {
  if (!repo || typeof rel !== 'string' || !rel) return null
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) return null
  let realRepo, realFile
  try { realRepo = realpathSync(repo) } catch { return null }
  try { realFile = realpathSync(join(repo, rel)) } catch { return null }
  if (realFile !== realRepo && !realFile.startsWith(realRepo + sep)) return null
  // Self-contained contract (Roland): return a safe regular-FILE path or null — never a directory — so a
  // future caller that forgets its own isFile() check can't be bitten (the /api/asset endpoint also checks).
  try { if (!statSync(realFile).isFile()) return null } catch { return null }
  return realFile
}

// #56: resolve a member's REPO-relative `rel` to a real IMAGE file contained in BOTH the repo AND the
// member's TERRITORY sub-tree — the guard for send_photo (an untrusted agent pushing bytes to an external
// service, so the root is tighter than the dashboard's repo-only read). TWO containment checks:
//   1. safeAssetPath(repo, rel) — repo-containment (realpath / isFile / reject ../abs/NUL/symlink/sibling).
//   2. the resolved realpath is within realpath(join(repo, territory)) — the SAME realpath + trailing-`sep`
//      rigor (a bare startsWith would let a sibling-prefix dir `<repo>/src-evil` leak past a `src` territory).
// Image-ext ONLY (reuse the allowlist but require image/* → excludes the #48c .mp3 and svg). territory='.'
// collapses check 2 to the repo check (a broad-territory relay member, by design). Returns { file } or
// { error } — never throws, fails closed.
export function resolveTerritoryImage(repo, territory, rel) {
  const file = safeAssetPath(repo, rel)
  if (!file) return { error: 'path is outside the repo, missing, or not a regular file' }
  let realTerr
  try { realTerr = realpathSync(join(repo, territory || '.')) } catch { return { error: 'territory not found' } }
  if (file !== realTerr && !file.startsWith(realTerr + sep)) return { error: `outside the member's territory (${territory || '.'})` }
  const ct = ASSET_CONTENT_TYPES[extname(file).toLowerCase()]
  if (!ct || !ct.startsWith('image/')) return { error: 'only image files (png/jpg/gif/webp) can be sent to Telegram' }
  return { file }
}
