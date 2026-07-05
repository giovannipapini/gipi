/**
 * Process tree helpers for background job management.
 *
 * Extracted from gipi-background/jobs.ts — handles:
 *   - Process group signalling (detached children on Unix)
 *   - PID existence checks
 *   - Graceful SIGTERM → SIGKILL escalation
 *
 * Usage:
 *   import { killProcessTree, isPidAlive } from '../../lib/process.js'
 */

const IS_UNIX = process.platform !== 'win32'

/**
 * Kill the entire process group of the given PID.
 *
 * With `detached: true` on Unix, the spawned child becomes a process-group
 * leader, so process.kill(-pid, sig) reaches every descendant (the shell AND
 * the actual server/watcher it spawned).
 *
 * Guards: PID 0 (self) and PID 1 (init) are never valid process-group leaders
 * for background jobs — prevents accidental signalling of the pi agent itself
 * or system processes.
 *
 * Returns false if the target no longer exists.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  if (!pid || pid < 2) return false
  try {
    if (IS_UNIX) process.kill(-pid, signal)
    else process.kill(pid, signal)
    return true
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Check whether a PID is still alive (signal 0 test). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Default grace period for SIGTERM → SIGKILL escalation (ms). */
export const SIGKILL_GRACE_MS = 1000
