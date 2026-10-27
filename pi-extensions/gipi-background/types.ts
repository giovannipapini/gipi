export type JobStatus = 'running' | 'exited' | 'killed' | 'failed'

export interface Job {
  id: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  status: JobStatus
  stdoutPath: string
  stderrPath: string
  stdoutOffset: number
  stderrOffset: number
  timeoutSeconds?: number
  /** Set when this run was spawned by a schedule. */
  scheduleId?: string
  /** 1-based run index within its schedule. */
  attempt?: number
}

/** What the `until` mode waits for. */
export type UntilCondition = 'exit_zero' | 'exit_nonzero' | 'stdout_contains' | 'stderr_contains'

/**
 * When a schedule wakes the agent:
 * - `none`       — never (inspect with bash_schedule_manage / /jobs)
 * - `on_success` — a run exited 0 (or `until` condition met)
 * - `on_failure` — a run exited non-zero, timed out, or failed to spawn
 * - `on_match`   — a run's output matched `matchPattern`
 * - `each`       — every completed run
 */
export type ScheduleNotify = 'none' | 'on_success' | 'on_failure' | 'on_match' | 'each'

/** `done` = `until` condition met; `exhausted` = maxAttempts reached. */
export type ScheduleStatus = 'active' | 'done' | 'exhausted' | 'cancelled'

export interface ScheduleBase {
  id: string
  command: string
  cwd: string
  /** Seconds between run starts (every) or between attempts (until). */
  intervalSeconds: number
  notify: ScheduleNotify
  /** Cap on total runs. Required for `until`, optional cap for `every`. */
  maxAttempts?: number
  timeoutSeconds?: number
  /** Runs started so far. */
  attempt: number
  createdAt: number
  /** Epoch ms of the next scheduled run; absent once the schedule stops. */
  nextRunAt?: number
  lastJobId?: string
  status: ScheduleStatus
  stoppedReason?: string
}

/** Re-runs forever on an interval; `matchPattern` only drives `notify=on_match`. */
export interface EverySchedule extends ScheduleBase {
  mode: 'every'
  matchPattern?: string
}

/** Retries until `untilCondition` holds or `maxAttempts` runs have failed. */
export interface UntilSchedule extends ScheduleBase {
  mode: 'until'
  untilCondition: UntilCondition
  matchPattern?: string
}

/**
 * A discriminated union so `mode === 'until'` always comes with a condition:
 * an `until` schedule without one cannot be constructed, so no code path has to
 * invent a fallback condition.
 */
export type Schedule = EverySchedule | UntilSchedule

/** A schedule production worth telling the agent about. */
export interface ScheduleEvent {
  schedule: Schedule
  job?: Job
  trigger: 'success' | 'failure' | 'match' | 'tick'
  note?: string
}

export type ScheduleCallback = (events: ScheduleEvent[]) => void
