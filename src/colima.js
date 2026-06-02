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
