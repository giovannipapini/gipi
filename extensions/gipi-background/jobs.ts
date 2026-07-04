import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getShellConfig } from '@earendil-works/pi-coding-agent'
import { ensureSessionDir, saveJobs, sessionDir } from './store.js'
import type { Job, JobStatus } from './types.js'

const ID_ALPHA = 'abcdefghijklmnopqrstuvwxyz'
const SIGKILL_GRACE_MS = 1000
const IS_UNIX = process.platform !== 'win32'

export function newJobId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const a = ID_ALPHA[Math.floor(Math.random() * 26)]
    const b = ID_ALPHA[Math.floor(Math.random() * 26)]
    const n = Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, '0')
    const id = `bg-${a}${b}${n}`
    if (!existing.has(id)) return id
  }
  return `bg-${Date.now().toString(36)}`
}

// Kill the entire process group. With `detached: true` on Unix, the spawned
// child becomes a process-group leader, so process.kill(-pid, sig) reaches
// every descendant (the shell AND the actual server/watcher it spawned).
// Returns false if the target no longer exists.
export function killProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  // PID 0 signals self's process group, PID 1 is init — both are never valid
  // process-group leaders for background jobs. Guard to prevent accidental
  // signaling of the pi agent itself or system processes.
  if (!pid || pid < 2) return false
  try {
    if (IS_UNIX) process.kill(-pid, signal)
    else process.kill(pid, signal)
    return true
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface JobRegistry {
  getAll(): Job[]
  get(id: string): Job | undefined
  startJob(opts: { command: string; cwd: string; timeoutSeconds?: number }): Job
  killJob(id: string, signal: NodeJS.Signals): boolean
  killAll(): Promise<void>
  restoreFromDisk(persisted: Job[]): void
  persist(): void
  updateOffsets(id: string, stdoutOffset: number, stderrOffset: number): void
}

export function createRegistry(sessionId: string, onChange: () => void): JobRegistry {
  const jobs = new Map<string, Job>()
  const sigkillTimers = new Map<string, NodeJS.Timeout>()
  const timeoutTimers = new Map<string, NodeJS.Timeout>()

  function persistNow() {
    saveJobs(sessionId, Array.from(jobs.values()))
  }

  function notifyChange() {
    persistNow()
    onChange()
  }

  function scheduleSigkill(job: Job) {
    clearTimer(sigkillTimers, job.id)
    sigkillTimers.set(
      job.id,
      setTimeout(() => {
        sigkillTimers.delete(job.id)
        if (jobs.get(job.id)?.status === 'running') killProcessTree(job.pid, 'SIGKILL')
      }, SIGKILL_GRACE_MS),
    )
  }

  function clearTimer(map: Map<string, NodeJS.Timeout>, id: string) {
    const t = map.get(id)
    if (t) {
      clearTimeout(t)
      map.delete(id)
    }
  }

  function markExited(job: Job, code: number | null, signal: NodeJS.Signals | null) {
    job.endedAt = Date.now()
    job.exitCode = code
    if (job.status === 'running') {
      job.status = signal ? 'killed' : code === 0 ? 'exited' : 'failed'
    }
    clearTimer(sigkillTimers, job.id)
    clearTimer(timeoutTimers, job.id)
    notifyChange()
  }

  return {
    getAll() {
      return Array.from(jobs.values())
    },
    get(id) {
      return jobs.get(id)
    },

    startJob({ command, cwd, timeoutSeconds }) {
      ensureSessionDir(sessionId)
      const id = newJobId(new Set(jobs.keys()))
      const stdoutPath = join(sessionDir(sessionId), `${id}.stdout`)
      const stderrPath = join(sessionDir(sessionId), `${id}.stderr`)
      const stdoutFd = openSync(stdoutPath, 'w')
      const stderrFd = openSync(stderrPath, 'w')

      const { shell, args } = getShellConfig()
      const child = spawn(shell, [...args, command], {
        cwd,
        detached: IS_UNIX,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
      })

      const job: Job = {
        id,
        pid: child.pid ?? -1,
        command,
        cwd,
        startedAt: Date.now(),
        status: 'running',
        stdoutPath,
        stderrPath,
        stdoutOffset: 0,
        stderrOffset: 0,
        timeoutSeconds,
      }
      jobs.set(id, job)

      // Attach listeners BEFORE closing the parent's copy of the fds and
      // BEFORE any async hop, so a synchronous spawn error is still caught.
      child.on('exit', (code, signal) => markExited(job, code, signal))
      child.on('error', () => {
        job.endedAt = Date.now()
        job.status = 'failed'
        clearTimer(sigkillTimers, job.id)
        clearTimer(timeoutTimers, job.id)
        notifyChange()
      })
      closeSync(stdoutFd)
      closeSync(stderrFd)
      if (IS_UNIX) child.unref()

      if (timeoutSeconds && timeoutSeconds > 0) {
        timeoutTimers.set(
          id,
          setTimeout(() => {
            timeoutTimers.delete(id)
            if (jobs.get(id)?.status === 'running') {
              killProcessTree(job.pid, 'SIGTERM')
              scheduleSigkill(job)
            }
          }, timeoutSeconds * 1000),
        )
      }

      notifyChange()
      return job
    },

    killJob(id, signal) {
      const job = jobs.get(id)
      if (job?.status !== 'running') return false
      const ok = killProcessTree(job.pid, signal)
      if (ok && signal === 'SIGTERM') scheduleSigkill(job)
      return ok
    },

    async killAll() {
      const running = Array.from(jobs.values()).filter((j) => j.status === 'running')
      for (const j of running) killProcessTree(j.pid, 'SIGTERM')
      await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS))
      for (const j of running) {
        if (jobs.get(j.id)?.status === 'running') killProcessTree(j.pid, 'SIGKILL')
      }
    },

    restoreFromDisk(persisted) {
      for (const p of persisted) {
        let status: JobStatus = p.status
        if (status === 'running' && !isPidAlive(p.pid)) status = 'exited'
        jobs.set(p.id, { ...p, status })
      }
      persistNow()
    },

    persist() {
      persistNow()
    },

    updateOffsets(id, stdoutOffset, stderrOffset) {
      const job = jobs.get(id)
      if (!job) return
      job.stdoutOffset = stdoutOffset
      job.stderrOffset = stderrOffset
    },
  }
}

export interface ReadResult {
  content: string
  bytesRead: number
  bytesSkipped: number
  newOffset: number
  fileSize: number
}

// Read the tail window via fd-positioned reads — avoids loading the whole
// log into memory when the file is large. When sinceLastRead=true and the
// gap is bigger than tailBytes, report the skipped count so callers can
// surface a "missed N bytes" warning.
export function readLogTail(
  path: string,
  fromOffset: number,
  tailBytes: number,
  sinceLastRead: boolean,
): ReadResult {
  if (!existsSync(path))
    return { content: '', bytesRead: 0, bytesSkipped: 0, newOffset: fromOffset, fileSize: 0 }
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    let start: number
    let bytesSkipped = 0
    if (sinceLastRead) {
      const from = Math.min(fromOffset, size)
      if (size - from > tailBytes) {
        start = size - tailBytes
        bytesSkipped = start - from
      } else {
        start = from
      }
    } else {
      start = Math.max(0, size - tailBytes)
    }
    const length = size - start
    if (length <= 0)
      return { content: '', bytesRead: 0, bytesSkipped, newOffset: size, fileSize: size }
    const buf = Buffer.alloc(length)
    const actual = readSync(fd, buf, 0, length, start)
    return {
      content: buf.toString('utf8', 0, actual),
      bytesRead: actual,
      bytesSkipped,
      newOffset: size,
      fileSize: size,
    }
  } finally {
    closeSync(fd)
  }
}
