import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { spinner, dbg } from './output.js'

function detectCpus() {
  try { return parseInt(execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).trim(), 10) } catch {}
  return os.cpus().length || 4
}

function detectMemory() {
  try {
    const bytes = parseInt(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim(), 10)
    return Math.max(8, Math.floor(bytes / 1073741824 / 2))
  } catch {}
  return Math.max(8, Math.floor(os.totalmem() / 1073741824 / 2))
}

/** CPUs of the running Colima VM (or null) — used to warn when it's smaller than what we'd start now. */
function runningColimaCpus() {
  try {
    const out = execFileSync('colima', ['list', '--json'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      let o; try { o = JSON.parse(line) } catch { continue }
      if ((o.status === 'Running' || o.name === 'default') && Number(o.cpus)) return Number(o.cpus)
    }
  } catch {}
  return null
}

/** RAM (GB) of the running Colima VM (or null) — to warn when it's smaller than what we'd start now. A VM first
 * started small (old default / 8GB floor / manual) stays small; a memory-starved VM OOM-kills containers (exit 137,
 * e.g. a summoned Pierre) under heavy load (many mrc sessions + container-spawning wire-tests). */
function runningColimaMemoryGb() {
  try {
    const out = execFileSync('colima', ['list', '--json'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      let o; try { o = JSON.parse(line) } catch { continue }
      if ((o.status === 'Running' || o.name === 'default') && Number(o.memory)) return Math.round(Number(o.memory) / 1073741824)
    }
  } catch {}
  return null
}

/**
 * Ensure Docker is available. On macOS, starts Colima if needed.
 * Returns true if we started Colima (so we can stop it on exit).
 */
export async function ensureDocker(verbose, { colimaCpu, colimaMemory } = {}) {
  const hasColima = (() => {
    try { execFileSync('which', ['colima'], { stdio: 'ignore' }); return true } catch { return false }
  })()

  if (hasColima) {
    // Set DOCKER_HOST if not already set
    if (!process.env.DOCKER_HOST) {
      process.env.DOCKER_HOST = `unix://${join(process.env.HOME, '.colima/default/docker.sock')}`
    }

    // Check if Colima is running
    try {
      execFileSync('colima', ['status'], { stdio: 'ignore' })
      // Already running. Colima won't resize a live VM, so a VM first started small stays small —
      // warn if it has fewer CPUs than we'd allocate now (this caps room/workflow concurrency).
      const want = parseInt(colimaCpu, 10) || detectCpus()
      const have = runningColimaCpus()
      if (have && want && have < want) {
        console.log(`  ⚠ Colima VM is running with ${have} CPUs but ${want} are available — room/workflow`)
        console.log(`    concurrency is capped (min(16, cpus-2)). Colima can't resize a live VM; to use all`)
        console.log(`    cores: 'colima stop' then relaunch mrc (restarts the VM, ending running sessions).`)
      }
      const wantMem = parseInt(colimaMemory, 10) || detectMemory()
      const haveMem = runningColimaMemoryGb()
      if (haveMem && wantMem && haveMem < wantMem - 1) {   // -1 slack for byte→GB rounding
        console.log(`  ⚠ Colima VM is running with ~${haveMem}GB RAM but ${wantMem}GB are available — heavy container`)
        console.log(`    load (many mrc sessions + container-spawning wire-tests) can OOM-kill a container (exit 137,`)
        console.log(`    e.g. a summoned Pierre). Colima can't resize a live VM; to raise it: close sessions, then`)
        console.log(`    'colima stop' and relaunch mrc (or pass --colima-memory N / set it in ~/.mrcrc).`)
      }
      return false  // already running
    } catch {
      // Need to start Colima
      console.log('🎩 Preparing ship for Ludicrous Speed...')
      const cpu = colimaCpu || detectCpus()
      const memory = colimaMemory || detectMemory()
      const flags = ['--vm-type', 'vz', '--mount-type', 'virtiofs', '--cpu', String(cpu), '--memory', String(memory)]
      await spinner(
        new Promise((resolve, reject) => {
          const child = spawn('colima', ['start', ...flags], {
            stdio: verbose ? 'inherit' : 'ignore',
          })
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`colima exit ${code}`)))
          child.on('error', reject)
        })
      )
      console.log('  ✓ Ship ready. All bleeps, sweeps, and creeps accounted for.')
      return true
    }
  }

  // No Colima — check Docker directly
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return false
  } catch {
    console.error("We've lost the bleeps, the sweeps, AND the creeps.")
    console.error('Error: Docker is not running and Colima is not installed.')
    process.exit(1)
  }
}
