import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getShellConfig } from '@earendil-works/pi-coding-agent'
import type { Options } from 'execa'
import { execa } from 'execa'
import { jobId, scheduleId as newScheduleId } from '../../lib/id.js'
import { isPidAlive, killProcessTree, SIGKILL_GRACE_MS } from '../../lib/process.js'
import {
  describeUntil,
  evaluateUntil,
  matchesPattern,
  nextRunAt,
  shouldNotify,
  untilNeedsPattern,
} from '../../lib/schedule.js'
import { ensureSessionDir, saveJobs, saveSchedules, sessionDir } from './store.js'
import type {
  Job,
  JobStatus,
  Schedule,
  ScheduleBase,
  ScheduleCallback,
  ScheduleEvent,
  ScheduleNotify,
  ScheduleStatus,
  UntilCondition,
} from './types.js'

const IS_UNIX = process.platform !== 'win32'

export { isPidAlive, killProcessTree, SIGKILL_GRACE_MS }

/** Tail window read when a schedule needs to pattern-match a run's output. */
const MATCH_TAIL_BYTES = 64 * 1024

/** How long after startup a restored schedule waits before its first catch-up run. */
const RESTORE_GRACE_MS = 250

/** Liveness poll interval for runs restored after a reload. */
const RESTORE_POLL_MS = 2000

/** Bound on the settle-dedupe set; ids are only ever added once per job. */
const SETTLED_CAP = 4096

interface SpawnJobOptions {
  command: string
  cwd: string
  timeoutSeconds?: number
  scheduleId?: string
  attempt?: number
}

interface StartScheduleBase {
  command: string
  cwd: string
  intervalSeconds: number
  notify: ScheduleNotify
  maxAttempts?: number
  timeoutSeconds?: number
}

/** Mirrors `Schedule`: an `until` start must carry its condition. */
export type StartScheduleOptions =
  | (StartScheduleBase & { mode: 'every'; matchPattern?: string })
  | (StartScheduleBase & { mode: 'until'; untilCondition: UntilCondition; matchPattern?: string })

export interface JobRegistry {
  getAll(): Job[]
  get(id: string): Job | undefined
  startJob(opts: { command: string; cwd: string; timeoutSeconds?: number }): Job
  killJob(id: string, signal: NodeJS.Signals): boolean
  killAll(): Promise<void>
  restoreFromDisk(persisted: Job[], persistedSchedules?: Schedule[]): void
  persist(): void
  updateOffsets(id: string, stdoutOffset: number, stderrOffset: number): void
  getSchedules(): Schedule[]
  getSchedule(id: string): Schedule | undefined
  startSchedule(opts: StartScheduleOptions): Schedule
  cancelSchedule(id: string): Schedule | undefined
  triggerSchedule(id: string): Schedule | undefined
  /** Stop every schedule timer without touching running jobs (reload/shutdown). */
  stopTimers(): void
}

export function createRegistry(
  sessionId: string,
  onChange: () => void,
  onCallback: ScheduleCallback,
): JobRegistry {
  const jobs = new Map<string, Job>()
  const schedules = new Map<string, Schedule>()
  const sigkillTimers = new Map<string, NodeJS.Timeout>()
  const timeoutTimers = new Map<string, NodeJS.Timeout>()
  const scheduleTimers = new Map<string, NodeJS.Timeout>()
  /** Liveness pollers for runs that outlived a reload (their 'exit' listener did not). */
  const livenessTimers = new Map<string, NodeJS.Timeout>()
  /** Jobs already fed into schedule bookkeeping — child events can double-fire. */
  const settled = new Set<string>()

  function persistNow() {
    // Called from child-process handlers and schedule timers, where ANY throw
    // becomes an uncaughtException → pi's uncaughtCrash() → session death.
    try {
      saveJobs(sessionId, Array.from(jobs.values()))
    } catch (err) {
      console.error('[gipi-background] persist jobs failed:', err)
    }
    try {
      saveSchedules(sessionId, Array.from(schedules.values()))
    } catch (err) {
      console.error('[gipi-background] persist schedules failed:', err)
    }
  }

  function notifyChange() {
    persistNow()
    try {
      onChange()
    } catch (err) {
      console.error('[gipi-background] onChange failed:', err)
    }
  }

  function emit(events: ScheduleEvent[]) {
    if (events.length === 0) return
    try {
      onCallback(events)
    } catch (err) {
      console.error('[gipi-background] callback failed:', err)
    }
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
    scheduleAfterJob(job)
  }

  // ── Schedule engine ──────────────────────────────────────────────────────

  function scheduleOf(id: string): Schedule | undefined {
    return schedules.get(id)
  }

  /** The run of this schedule still in flight, if any. No side effects. */
  function inFlightRun(id: string): Job | undefined {
    for (const job of jobs.values()) {
      if (job.scheduleId === id && job.status === 'running') return job
    }
    return undefined
  }

  /**
   * Close out a run whose process is gone and whose 'exit' event we will never
   * receive, because it outlived the runtime that was listening for it.
   *
   * Deliberately does no schedule bookkeeping: the caller is about to run the
   * next tick itself, and settling here would also arm a second timer.
   */
  function abandonDeadRun(job: Job) {
    job.status = 'exited'
    job.exitCode = null
    job.endedAt = Date.now()
    notifyChange()
  }

  /** Arm the next tick `dueAt` ms from now (defaults to the schedule's own due time). */
  function arm(s: Schedule, dueAt?: number) {
    clearTimer(scheduleTimers, s.id)
    if (s.status !== 'active') return
    const wait = Math.max(0, (dueAt ?? s.nextRunAt ?? Date.now()) - Date.now())
    scheduleTimers.set(
      s.id,
      // setTimeout callbacks are top-level: a throw here kills the session.
      setTimeout(() => tick(s.id), wait),
    )
  }

  /**
   * Re-attach to a run that survived a reload.
   *
   * Its ChildProcess listener and pid are gone from our side, so the only way to
   * learn it finished is to poll. Without this the schedule's overlap guard
   * would see a permanent "running" run.
   */
  function watchRestoredRun(job: Job) {
    clearTimer(livenessTimers, job.id)
    livenessTimers.set(
      job.id,
      setInterval(() => {
        if (isPidAlive(job.pid)) return
        clearTimer(livenessTimers, job.id)
        if (jobs.get(job.id)?.status !== 'running') return
        abandonDeadRun(job)
        // Nothing else will settle this run, so bookkeeping (and the next
        // attempt for an `until` schedule) happens here.
        scheduleAfterJob(job)
      }, RESTORE_POLL_MS),
    )
  }

  function stopSchedule(s: Schedule, status: ScheduleStatus, reason: string) {
    s.status = status
    s.stoppedReason = reason
    s.nextRunAt = undefined
    clearTimer(scheduleTimers, s.id)
  }

  function tick(id: string) {
    try {
      scheduleTimers.delete(id)
      const s = scheduleOf(id)
      if (s?.status !== 'active') return

      // A cap reached while the runtime was down must not spawn one extra run.
      if (s.maxAttempts && s.attempt >= s.maxAttempts) {
        stopSchedule(s, 'exhausted', `reached max_attempts (${s.maxAttempts})`)
        notifyChange()
        return
      }

      let running = inFlightRun(id)
      if (running && !isPidAlive(running.pid)) {
        // The liveness poller has not noticed yet; do not let a corpse block
        // this schedule forever.
        abandonDeadRun(running)
        running = undefined
      }
      if (running) {
        // Overlap guard: a slow run must not stack up parallel runs. Skip this
        // tick and look again after the interval.
        s.nextRunAt = nextRunAt(Date.now(), s.intervalSeconds)
        arm(s)
        notifyChange()
        return
      }

      const attempt = s.attempt + 1
      const job = spawnJob({
        command: s.command,
        cwd: s.cwd,
        timeoutSeconds: s.timeoutSeconds,
        scheduleId: s.id,
        attempt,
      })
      s.attempt = attempt
      s.lastJobId = job.id
      // `every` paces from run start; `until` paces from run completion so a
      // slow command is not retried hot.
      if (s.mode === 'every') {
        s.nextRunAt = nextRunAt(Date.now(), s.intervalSeconds)
        arm(s)
      }
      notifyChange()
      // Synchronous spawn failure never emits 'exit', so settle it here.
      if (job.status !== 'running') scheduleAfterJob(job)
    } catch (err) {
      console.error('[gipi-background] schedule tick failed:', err)
    }
  }

  /** Output tails of a finished run, for condition and pattern matching. */
  function readRunOutput(job: Job): { stdout: string; stderr: string } {
    return {
      stdout: readLogTail(job.stdoutPath, 0, MATCH_TAIL_BYTES, false).content,
      stderr: readLogTail(job.stderrPath, 0, MATCH_TAIL_BYTES, false).content,
    }
  }

  interface RunOutput {
    stdout: string
    stderr: string
  }

  /**
   * Move an `until` schedule on: stop it if the condition held or the cap is
   * reached, otherwise arm the next attempt. `every` schedules are already
   * armed by tick() and are only capped here.
   */
  function advanceOrStop(
    s: Schedule,
    job: Job,
    output: RunOutput,
  ): { matchedUntil: boolean; stoppedNow: boolean } {
    if (s.status !== 'active') return { matchedUntil: false, stoppedNow: false }

    if (s.mode === 'until') {
      const matchedUntil = evaluateUntil(s.untilCondition, {
        exitCode: job.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        matchPattern: s.matchPattern,
      })
      if (matchedUntil) {
        stopSchedule(
          s,
          'done',
          `condition met (${describeUntil(s.untilCondition, s.matchPattern)}) after ${s.attempt} run(s)`,
        )
        return { matchedUntil, stoppedNow: true }
      }
      if (s.maxAttempts && s.attempt >= s.maxAttempts) {
        stopSchedule(s, 'exhausted', `gave up after ${s.attempt} run(s); condition never met`)
        return { matchedUntil, stoppedNow: true }
      }
      s.nextRunAt = nextRunAt(Date.now(), s.intervalSeconds)
      arm(s)
      return { matchedUntil, stoppedNow: false }
    }

    if (s.maxAttempts && s.attempt >= s.maxAttempts) {
      stopSchedule(s, 'exhausted', `reached max_attempts (${s.maxAttempts})`)
      return { matchedUntil: false, stoppedNow: true }
    }
    return { matchedUntil: false, stoppedNow: false }
  }

  /**
   * Bookkeeping after one scheduled run settles: advance the schedule, then
   * wake the agent if its `notify` mode or a stop makes that worth doing.
   */
  function scheduleAfterJob(job: Job) {
    try {
      if (!job.scheduleId || settled.has(job.id)) return
      if (settled.size > SETTLED_CAP) settled.clear()
      settled.add(job.id)
      const s = scheduleOf(job.scheduleId)
      if (!s) return

      const success = job.status === 'exited' && job.exitCode === 0
      // Reading both logs is only worth it when something actually looks at them.
      const needsOutput =
        s.notify === 'on_match' || (s.mode === 'until' && untilNeedsPattern(s.untilCondition))
      const output = needsOutput ? readRunOutput(job) : { stdout: '', stderr: '' }
      const matched = s.matchPattern
        ? matchesPattern(`${output.stdout}\n${output.stderr}`, s.matchPattern)
        : false

      const { matchedUntil, stoppedNow } = advanceOrStop(s, job, output)

      // One wake-up decision per finished run:
      //  - the run's own outcome matches `notify`
      //  - `on_match` matched the combined output
      //  - `until` reached its condition, whatever the run's exit status was
      //  - the schedule just stopped, which is always worth knowing
      // `notify: none` stays absolute: a user who asked for silence gets silence.
      const notifyNow =
        s.notify !== 'none' &&
        (stoppedNow ||
          shouldNotify(s.notify, success ? 'success' : 'failure') ||
          (matched && s.notify === 'on_match') ||
          matchedUntil)

      persistNow()
      if (!notifyNow) return
      emit([
        {
          // Snapshot: the callback queue renders up to a second later, and a
          // live reference would report the schedule's *next* state.
          schedule: { ...s },
          job,
          trigger: matched ? 'match' : success ? 'success' : 'failure',
          note: s.stoppedReason,
        },
      ])
    } catch (err) {
      console.error('[gipi-background] schedule bookkeeping failed:', err)
    }
  }

  function spawnJob({ command, cwd, timeoutSeconds, scheduleId, attempt }: SpawnJobOptions): Job {
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
      scheduleId,
      attempt,
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
        // CRITICAL: never let execa reject. The promise is intentionally not
        // awaited (the job outlives this call), and execa's default
        // `reject: true` makes a non-zero exit / signal kill reject it →
        // unhandled promise rejection → Node crashes → pi session dies.
        // Status is tracked via the 'exit'/'error' events below instead.
        reject: false,
      } satisfies Options
      const child = execa(command, execaOpts)
      // execa 10 exposes Node's ChildProcess (and its events, ref/unref) only
      // through this escape hatch; the subprocess itself is a Promise-like.
      const nodeChild = child.nodeChildProcess

      job.pid = child.pid ?? -1
      job.status = 'running'
      jobs.set(id, job)

      // Attach listeners BEFORE closing the parent's copy of the fds and
      // BEFORE any async hop, so a synchronous spawn error is still caught.
      nodeChild.on('exit', (code, signal) => markExited(job, code, signal))
      nodeChild.on('error', () => {
        job.endedAt = Date.now()
        job.status = 'failed'
        clearTimer(sigkillTimers, job.id)
        clearTimer(timeoutTimers, job.id)
        notifyChange()
        scheduleAfterJob(job)
      })
      if (IS_UNIX) nodeChild.unref()

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
  }

  return {
    getAll() {
      return Array.from(jobs.values())
    },
    get(id) {
      return jobs.get(id)
    },

    startJob({ command, cwd, timeoutSeconds }) {
      return spawnJob({ command, cwd, timeoutSeconds })
    },

    killJob(id, signal) {
      const job = jobs.get(id)
      if (job?.status !== 'running') return false
      const ok = killProcessTree(job.pid, signal)
      if (ok && signal === 'SIGTERM') scheduleSigkill(job)
      return ok
    },

    async killAll() {
      for (const timer of scheduleTimers.values()) clearTimeout(timer)
      scheduleTimers.clear()
      for (const timer of livenessTimers.values()) clearInterval(timer)
      livenessTimers.clear()
      const running = Array.from(jobs.values()).filter((j) => j.status === 'running')
      for (const j of running) killProcessTree(j.pid, 'SIGTERM')
      await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS))
      for (const j of running) {
        if (jobs.get(j.id)?.status === 'running') killProcessTree(j.pid, 'SIGKILL')
      }
    },

    restoreFromDisk(persisted, persistedSchedules = []) {
      for (const p of persisted) {
        let status: JobStatus = p.status
        if (status === 'running' && !isPidAlive(p.pid)) status = 'exited'
        const job: Job = { ...p, status }
        jobs.set(job.id, job)
        // A run that outlived the runtime lost its 'exit' listener: poll it, or
        // its schedule deadlocks on the overlap guard.
        if (job.status === 'running' && job.scheduleId) watchRestoredRun(job)
      }
      for (const p of persistedSchedules) {
        schedules.set(p.id, { ...p })
      }
      // Re-arm schedules that were live when the runtime went away. Without
      // this a `/reload` would silently freeze every schedule.
      for (const s of schedules.values()) {
        if (s.status !== 'active') continue
        s.nextRunAt = Math.max(s.nextRunAt ?? 0, Date.now() + RESTORE_GRACE_MS)
        arm(s)
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

    getSchedules() {
      return Array.from(schedules.values()).sort((a, b) => a.createdAt - b.createdAt)
    },

    getSchedule(id) {
      return schedules.get(id)
    },

    startSchedule(opts) {
      const base: ScheduleBase = {
        id: newScheduleId(),
        command: opts.command,
        cwd: opts.cwd,
        intervalSeconds: opts.intervalSeconds,
        notify: opts.notify,
        maxAttempts: opts.maxAttempts,
        timeoutSeconds: opts.timeoutSeconds,
        attempt: 0,
        createdAt: Date.now(),
        status: 'active',
      }
      const schedule: Schedule =
        opts.mode === 'until'
          ? {
              ...base,
              mode: 'until',
              untilCondition: opts.untilCondition,
              matchPattern: opts.matchPattern,
            }
          : { ...base, mode: 'every', matchPattern: opts.matchPattern }
      schedules.set(schedule.id, schedule)
      // First run is immediate; arm() with a 0ms delay keeps one code path.
      schedule.nextRunAt = Date.now()
      arm(schedule, Date.now())
      notifyChange()
      return schedule
    },

    cancelSchedule(id) {
      const s = schedules.get(id)
      if (!s) return undefined
      if (s.status === 'active') stopSchedule(s, 'cancelled', 'cancelled by request')
      notifyChange()
      return s
    },

    triggerSchedule(id) {
      const s = schedules.get(id)
      if (s?.status !== 'active') return s
      s.nextRunAt = Date.now()
      arm(s, Date.now())
      notifyChange()
      return s
    },

    stopTimers() {
      for (const timer of scheduleTimers.values()) clearTimeout(timer)
      scheduleTimers.clear()
      for (const timer of livenessTimers.values()) clearInterval(timer)
      livenessTimers.clear()
    },
  }
}

export interface LogReadTailResult {
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
  fromByteOffset: number,
  tailBytes: number,
  sinceLastRead: boolean,
): LogReadTailResult {
  if (!existsSync(path))
    return {
      content: '',
      bytesRead: 0,
      bytesSkipped: 0,
      newOffset: fromByteOffset,
      fileSize: 0,
    }
  const fd = openSync(path, 'r')
  try {
    const fileSizeBytes = statSync(path).size
    let start: number
    let bytesSkipped = 0
    if (sinceLastRead) {
      const from = Math.min(fromByteOffset, fileSizeBytes)
      if (fileSizeBytes - from > tailBytes) {
        start = fileSizeBytes - tailBytes
        bytesSkipped = start - from
      } else {
        start = from
      }
    } else {
      start = Math.max(0, fileSizeBytes - tailBytes)
    }
    const length = fileSizeBytes - start
    if (length <= 0)
      return {
        content: '',
        bytesRead: 0,
        bytesSkipped,
        newOffset: fileSizeBytes,
        fileSize: fileSizeBytes,
      }
    const buffer = Buffer.alloc(length)
    const actual = readSync(fd, buffer, 0, length, start)
    return {
      content: buffer.toString('utf8', 0, actual),
      bytesRead: actual,
      bytesSkipped,
      newOffset: fileSizeBytes,
      fileSize: fileSizeBytes,
    }
  } finally {
    closeSync(fd)
  }
}
