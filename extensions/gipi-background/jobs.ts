import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getShellConfig } from '@earendil-works/pi-coding-agent'
import type { Options } from 'execa'
import { execaCommand } from 'execa'
import { jobId } from '../../lib/id.js'
import { isPidAlive, killProcessTree, SIGKILL_GRACE_MS } from '../../lib/process.js'
import { ensureSessionDir, saveJobs, sessionDir } from './store.js'
import type { Job, JobStatus } from './types.js'

const IS_UNIX = process.platform !== 'win32'

export { isPidAlive, killProcessTree, SIGKILL_GRACE_MS }

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
      const id = jobId()
      const stdoutPath = join(sessionDir(sessionId), `${id}.stdout`)
      const stderrPath = join(sessionDir(sessionId), `${id}.stderr`)

      // Pre-build the job object so we can return it even if spawning fails.
      const job: Job = {
        id,
        pid: -1,
        command,
        cwd,
        startedAt: Date.now(),
        status: 'failed',
        stdoutPath,
        stderrPath,
        stdoutOffset: 0,
        stderrOffset: 0,
        timeoutSeconds,
      }

      try {
        const { shell: shellPath } = getShellConfig()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const execaOpts = {
          cwd,
          shell: shellPath,
          detached: IS_UNIX,
          stdin: 'ignore',
          stdout: { file: stdoutPath },
          stderr: { file: stderrPath },
        } satisfies Options
        const child = execaCommand(command, execaOpts)

        job.pid = child.pid ?? -1
        job.status = 'running'
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
      } catch (err) {
        // Spawn failed (e.g. shell not found, ENOENT). Register as failed
        // so the caller can inspect the error via bash_async_manage stderr.
        job.endedAt = Date.now()
        job.exitCode = null
        jobs.set(id, job)
        // Write the error to stderr for post-mortem inspection.
        try {
          writeFileSync(stderrPath, `spawn error: ${(err as Error).message ?? err}\n`, 'utf8')
        } catch {
          // best-effort
        }
        notifyChange()
      }

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
