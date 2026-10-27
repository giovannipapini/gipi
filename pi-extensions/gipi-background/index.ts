/**
 * gipi-background Extension
 *
 * Two tools: `bash_async` spawns a long-running shell command and returns
 * immediately; `bash_async_manage` reads stdout/stderr, kills, or lists jobs
 * started by it.
 *
 * Two more: `bash_schedule` runs a command on an interval (`every`) or retries
 * it until a condition holds (`until`); `bash_schedule_manage` lists, cancels,
 * or triggers schedules. A schedule can wake the agent when something happens
 * (`notify`) instead of making it poll.
 *
 * A `/jobs` command opens an interactive TUI manager for the user to browse,
 * live-tail, and kill background jobs without spending an agent turn.
 *
 * Jobs are session-scoped: logs spool to <agentDir>/gipi-background/<sessionId>/,
 * registry is persisted to jobs.json (+ schedules.json). The whole tree is
 * killed on quit; on /reload (and session replacement) jobs and schedules
 * survive and are re-attached.
 *
 * Placement: ~/.pi/agent/extensions/gipi-background/index.ts (symlinked from dotfiles).
 */

import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import {
  describeUntil,
  formatInterval,
  parseInterval,
  untilNeedsPattern,
} from '../../lib/schedule.js'
import { createRegistry, type JobRegistry, readLogTail } from './jobs.js'
import { loadJobs, loadSchedules, purgeSessionDir } from './store.js'
import type { Job, Schedule, ScheduleEvent } from './types.js'

const EXEC_PROMPT_SNIPPET =
  'Run a shell command in the background and return immediately. ' +
  'Use this instead of `bash` for anything that does not finish promptly — dev servers, file watchers, long builds you want to observe live. ' +
  'Read its output later with bash_async_manage (action=stdout/stderr) and always bash_async_manage (action=kill) when done.'

const MANAGE_PROMPT_SNIPPET =
  'Read output from, kill, or list background jobs started with bash_async. ' +
  'action=stdout/stderr returns new bytes since the last read (set since_last_read=false for a full tail). ' +
  'action=kill terminates a job. action=list shows all jobs in this session.'

const SCHEDULE_PROMPT_SNIPPET =
  'Run a command on a schedule instead of polling it yourself. every="30s" re-runs on an interval; ' +
  'until="exit_zero|stdout_contains|..." retries until a condition holds. ' +
  'notify (default on_failure, or on_success for until) wakes you with a message when it fires — ' +
  'so do not poll: start the schedule, keep working, and answer the wake-up. ' +
  'Stop it with bash_schedule_manage action=cancel.'

const SCHEDULE_MANAGE_PROMPT_SNIPPET =
  'List, cancel, or trigger-now the schedules started with bash_schedule. ' +
  'action=list shows each schedule with status, run count, and next run; ' +
  'action=cancel stops one; action=trigger runs it immediately.'

const PREVIEW_DELAY_MS = 250
const PREVIEW_BYTES = 4096
const PREVIEW_LINES = 20
const DEFAULT_TAIL_BYTES = 16 * 1024
const MAX_TAIL_BYTES = 256 * 1024

/** Callback batching: several runs finishing together become one message. */
const CALLBACK_COALESCE_MS = 1500
/** Hard cap on queued events; older ones are dropped with a note. */
const CALLBACK_QUEUE_MAX = 20
/** Per-schedule wake-ups per minute — a 1s schedule must not spam the model. */
const CALLBACK_RATE_MAX = 6
const CALLBACK_RATE_WINDOW_MS = 60_000
/** Output tail quoted in a callback message. */
const CALLBACK_TAIL_BYTES = 1200
const CALLBACK_TAIL_LINES = 8

const DEFAULT_EVERY = '60s'
const DEFAULT_UNTIL_INTERVAL = '10s'
const DEFAULT_UNTIL_ATTEMPTS = 10

function formatJob(j: Job): string {
  const dur = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000
  const exit = j.exitCode === undefined || j.exitCode === null ? '' : ` exit=${j.exitCode}`
  return `${j.id} pid=${j.pid} status=${j.status}${exit} dur=${dur.toFixed(1)}s cwd=${j.cwd}\n  $ ${j.command}`
}

function previewTail(content: string): string {
  if (!content) return ''
  const t = truncateTail(content, { maxBytes: PREVIEW_BYTES, maxLines: PREVIEW_LINES })
  return t.content
}

function statusLabel(reg: JobRegistry): string | undefined {
  const running = reg.getAll().filter((j) => j.status === 'running').length
  const scheduled = reg.getSchedules().filter((s) => s.status === 'active').length
  if (running === 0 && scheduled === 0) return undefined
  const parts: string[] = []
  if (running > 0) parts.push(`bg ${running}`)
  if (scheduled > 0) parts.push(`${scheduled} sched`)
  return parts.join(' · ')
}

function formatSchedule(s: Schedule): string {
  const what =
    s.mode === 'every'
      ? `every ${formatInterval(s.intervalSeconds)}`
      : `until ${describeUntil(s.untilCondition, s.matchPattern)}`
  const runs = s.maxAttempts ? `runs=${s.attempt}/${s.maxAttempts}` : `runs=${s.attempt}`
  const next =
    s.status === 'active' && s.nextRunAt
      ? ` next_in=${Math.max(0, Math.round((s.nextRunAt - Date.now()) / 1000))}s`
      : ''
  const last = s.lastJobId ? ` last=${s.lastJobId}` : ''
  const stop = s.stoppedReason ? `\n  stopped: ${s.stoppedReason}` : ''
  return `${s.id} mode=${s.mode} ${what} status=${s.status} ${runs} notify=${s.notify}${next}${last}\n  $ ${s.command}\n  cwd=${s.cwd}${stop}`
}

const SCHEDULE_GLYPH: Record<Schedule['status'], string> = {
  active: '●',
  done: '✓',
  exhausted: '!',
  cancelled: '✗',
}

const SCHEDULE_COLOR = {
  active: 'accent',
  done: 'success',
  exhausted: 'warning',
  cancelled: 'dim',
} as const satisfies Record<Schedule['status'], string>

const STATUS_GLYPH: Record<Job['status'], string> = {
  running: '●',
  exited: '✓',
  killed: '✗',
  failed: '✗',
}

const STATUS_COLOR = {
  running: 'accent',
  exited: 'success',
  killed: 'warning',
  failed: 'error',
} as const satisfies Record<Job['status'], string>

const MANAGER_TAIL_BYTES = 64 * 1024
const MANAGER_OUTPUT_LINES = 18
const MANAGER_POLL_MS = 700

function formatDuration(j: Job): string {
  const s = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000
  if (s < 60) return `${s.toFixed(0)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export default function extension(pi: ExtensionAPI) {
  let registry: JobRegistry | undefined
  let sessionId: string | undefined
  /** Latest context, kept for idle checks: timers have no ctx of their own. */
  let lastCtx: ExtensionContext | undefined

  // ── Callback queue ───────────────────────────────────────────────────────
  // Schedule fires land here, then flush as ONE user message: a 5s schedule
  // must not turn into 720 model turns an hour, and the agent should not have
  // to poll `bash_async_manage` to learn that the build finished.

  const pendingEvents: ScheduleEvent[] = []
  const deliveryStamps = new Map<string, number[]>()
  /** Per-schedule count of events swallowed by the rate limit, reported later. */
  const suppressedCounts = new Map<string, number>()
  let pendingDropped = 0
  let flushTimer: NodeJS.Timeout | undefined

  /** Spend one wake-up slot for this schedule; false when it is over budget. */
  function takeDeliverySlot(id: string): boolean {
    const now = Date.now()
    const stamps = (deliveryStamps.get(id) ?? []).filter((t) => now - t < CALLBACK_RATE_WINDOW_MS)
    if (stamps.length >= CALLBACK_RATE_MAX) {
      deliveryStamps.set(id, stamps)
      return false
    }
    stamps.push(now)
    deliveryStamps.set(id, stamps)
    return true
  }

  function streamTail(job: Job, stream: 'stdout' | 'stderr'): string {
    const path = stream === 'stdout' ? job.stdoutPath : job.stderrPath
    const raw = readLogTail(path, 0, CALLBACK_TAIL_BYTES, false).content
    if (!raw.trim()) return ''
    return truncateTail(raw, {
      maxBytes: CALLBACK_TAIL_BYTES,
      maxLines: CALLBACK_TAIL_LINES,
    }).content.trimEnd()
  }

  function renderEvent(ev: ScheduleEvent): string {
    // Prefer live state: an event can sit in the coalescing queue for over a
    // second, and by then the schedule may have been cancelled or stopped. The
    // snapshot keeps the history; the status/timing in the message block is live.
    const s = registry?.getSchedule(ev.schedule.id) ?? ev.schedule
    const j = ev.job
    const what =
      s.mode === 'every'
        ? `every ${formatInterval(s.intervalSeconds)}`
        : `until ${describeUntil(s.untilCondition, s.matchPattern)}`
    const lines = [`${s.id} (${what}, notify=${s.notify}) status=${s.status}`, `  $ ${s.command}`]
    // A failure explains itself on stderr; everything else on stdout.
    const stream = ev.trigger === 'failure' ? 'stderr' : 'stdout'
    if (j) {
      const dur = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000
      const exit = j.exitCode === undefined || j.exitCode === null ? '?' : j.exitCode
      lines.push(
        `  run=${j.id} attempt=${j.attempt ?? s.attempt} result=${j.status} exit=${exit} dur=${dur.toFixed(1)}s`,
      )
    }
    if (ev.trigger === 'match' && s.matchPattern) lines.push(`  matched /${s.matchPattern}/`)
    if (s.status !== ev.schedule.status) {
      lines.push(`  (was ${ev.schedule.status} when this fired)`)
    }
    if (ev.note) lines.push(`  ${ev.note}`)
    if (s.status === 'active' && s.nextRunAt) {
      lines.push(
        `  still active — next run in ${Math.max(0, Math.round((s.nextRunAt - Date.now()) / 1000))}s`,
      )
    }
    const tail = j ? streamTail(j, stream) : ''
    if (tail) {
      lines.push(`  ${stream} (tail):`)
      for (const line of tail.split('\n')) lines.push(`    ${line}`)
    }
    const reads: string[] = []
    if (j) reads.push(`bash_async_manage action=${stream} id=${j.id}`)
    if (s.status === 'active') reads.push(`bash_schedule_manage action=cancel id=${s.id}`)
    if (reads.length > 0) lines.push(`  next: ${reads.join(' · ')}`)
    return lines.join('\n')
  }

  interface DeliveryBatch {
    accepted: ScheduleEvent[]
    suppressed: number
  }

  /** Drop events over the per-schedule rate limit, reporting the gap later. */
  function partitionByRateLimit(batch: ScheduleEvent[]): DeliveryBatch {
    const accepted: ScheduleEvent[] = []
    for (const ev of batch) {
      if (takeDeliverySlot(ev.schedule.id)) {
        accepted.push(ev)
        continue
      }
      suppressedCounts.set(ev.schedule.id, (suppressedCounts.get(ev.schedule.id) ?? 0) + 1)
    }
    // Silently swallowed events would leave the agent blind, so the next
    // accepted wake-up for that schedule reports what it missed.
    for (const ev of accepted) {
      const missing = suppressedCounts.get(ev.schedule.id)
      if (!missing) continue
      suppressedCounts.delete(ev.schedule.id)
      ev.note = [ev.note, `${missing} earlier event(s) suppressed by rate limit`]
        .filter(Boolean)
        .join(' · ')
    }
    return { accepted, suppressed: batch.length - accepted.length }
  }

  function renderBatch({ accepted, suppressed }: DeliveryBatch, dropped: number): string {
    const header = [`${accepted.length} event(s)`]
    if (dropped > 0) header.push(`${dropped} dropped (queue full)`)
    if (suppressed > 0) header.push(`${suppressed} suppressed (rate limit)`)
    const title = `[scheduled wake-up — ${header.join(', ')}]`
    if (accepted.length === 0) return title
    const stillRunning = accepted.some((ev) => ev.schedule.status === 'active')
    return [
      title,
      accepted.map(renderEvent).join('\n\n'),
      stillRunning
        ? 'These keep running in the background; no polling needed.'
        : 'Every listed schedule has stopped.',
    ].join('\n')
  }

  function flushCallbacks() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (pendingEvents.length === 0) return
    const batch = pendingEvents.splice(0, pendingEvents.length)
    const dropped = pendingDropped
    pendingDropped = 0
    const deliveries = partitionByRateLimit(batch)
    if (deliveries.accepted.length === 0 && dropped === 0) return

    // Idle → start a turn now. Busy → steer: the point of a wake-up is to put
    // this in front of the model, not to park it behind the current turn.
    const idle = lastCtx?.isIdle() ?? true
    try {
      pi.sendUserMessage(renderBatch(deliveries, dropped), idle ? {} : { deliverAs: 'steer' })
    } catch (err) {
      console.error('[gipi-background] wake-up delivery failed:', err)
    }
  }

  function queueCallback(events: ScheduleEvent[]) {
    for (const ev of events) {
      if (pendingEvents.length >= CALLBACK_QUEUE_MAX) {
        pendingEvents.shift()
        pendingDropped += 1
      }
      pendingEvents.push(ev)
    }
    if (flushTimer) return
    // Top-level timer: a throw inside would be an uncaughtException.
    flushTimer = setTimeout(() => {
      try {
        flushCallbacks()
      } catch (err) {
        console.error('[gipi-background] callback flush failed:', err)
      }
    }, CALLBACK_COALESCE_MS)
  }

  function ensureRegistry(ctx: ExtensionContext): JobRegistry {
    lastCtx = ctx
    const id = ctx.sessionManager.getSessionId()
    if (registry && sessionId === id) return registry
    sessionId = id
    const reg = createRegistry(
      id,
      () => ctx.ui.setStatus('gipi-background', statusLabel(reg)),
      queueCallback,
    )
    registry = reg
    registry.restoreFromDisk(loadJobs(id), loadSchedules(id))
    ctx.ui.setStatus('gipi-background', statusLabel(registry))
    return registry
  }

  function requireJob(reg: JobRegistry, id: string | undefined): Job {
    if (!id) throw new Error('`id` is required')
    const job = reg.get(id)
    if (!job) throw new Error(`Unknown job id: ${id}`)
    return job
  }

  pi.registerTool({
    name: 'bash_async',
    label: 'Bash (background)',
    description:
      'Spawn a long-running shell command and return immediately with a job id. ' +
      'Prefer this over the bash tool for anything that does not return promptly: dev servers, file watchers, long builds you want to observe live. ' +
      'Read output, kill, or list jobs with the bash_async_manage tool.',
    promptSnippet: EXEC_PROMPT_SNIPPET,
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        description: 'Shell command to run in the background.',
      }),
      cwd: Type.Optional(
        Type.String({ description: 'Working directory. Defaults to the session cwd.' }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: 'Hard kill after N seconds.', minimum: 1, maximum: 86_400 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)
      const job = reg.startJob({
        command: params.command,
        cwd: params.cwd ?? ctx.cwd,
        timeoutSeconds: params.timeout_seconds,
      })
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(t)
          resolve()
        }
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, PREVIEW_DELAY_MS)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      const live = reg.get(job.id) as Job
      const outPrev = previewTail(readLogTail(live.stdoutPath, 0, PREVIEW_BYTES, false).content)
      const errPrev = previewTail(readLogTail(live.stderrPath, 0, PREVIEW_BYTES, false).content)
      const text = [
        `Started ${live.id} pid=${live.pid} status=${live.status}`,
        `  $ ${live.command}`,
        `  cwd=${live.cwd}`,
        outPrev ? `--- stdout (preview) ---\n${outPrev}` : `(no stdout yet)`,
        errPrev ? `--- stderr (preview) ---\n${errPrev}` : `(no stderr yet)`,
      ].join('\n')
      return { content: [{ type: 'text', text }], details: {} }
    },
  })

  pi.registerTool({
    name: 'bash_async_manage',
    label: 'Bash (background) manage',
    description:
      'Read output from, kill, or list background jobs started with bash_async. ' +
      'action=stdout/stderr reads new output (since_last_read=false for a full tail); ' +
      'action=kill terminates a job by id; action=list shows all jobs in this session.',
    promptSnippet: MANAGE_PROMPT_SNIPPET,
    parameters: Type.Object({
      action: StringEnum(['stdout', 'stderr', 'kill', 'list'] as const, {
        description: 'What to do: stdout | stderr | kill | list',
      }),
      id: Type.Optional(Type.String({ description: 'Job id (required for stdout/stderr/kill).' })),
      tail_bytes: Type.Optional(
        Type.Number({
          description: 'Max bytes to return (stdout/stderr). Default 16384.',
          minimum: 1,
          maximum: MAX_TAIL_BYTES,
        }),
      ),
      since_last_read: Type.Optional(
        Type.Boolean({
          description: 'stdout/stderr: only new bytes since last read. Default true.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)
      const action = params.action

      if (action === 'list') {
        const all = reg.getAll()
        if (all.length === 0)
          return { content: [{ type: 'text', text: '(no background jobs)' }], details: {} }
        return { content: [{ type: 'text', text: all.map(formatJob).join('\n') }], details: {} }
      }

      if (action === 'kill') {
        const job = requireJob(reg, params.id)
        if (job.status !== 'running') {
          return {
            content: [
              {
                type: 'text',
                text: `${job.id} already ${job.status} (exit=${job.exitCode ?? '?'})`,
              },
            ],
            details: {},
          }
        }
        const ok = reg.killJob(job.id, 'SIGTERM')
        const text = ok
          ? `Sent SIGTERM to ${job.id} (pid=${job.pid}). Will SIGKILL after 1s if still alive.`
          : `Could not signal ${job.id} (pid=${job.pid}) — process may have already exited.`
        return { content: [{ type: 'text', text }], details: {} }
      }

      if (action !== 'stdout' && action !== 'stderr') {
        const _exhaustive: never = action
        throw new Error(`Unknown action: ${_exhaustive}`)
      }
      const job = requireJob(reg, params.id)
      const tailBytes = Math.max(
        1,
        Math.min(params.tail_bytes ?? DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES),
      )
      const sinceLast = params.since_last_read ?? true
      const path = action === 'stdout' ? job.stdoutPath : job.stderrPath
      const fromOffset = action === 'stdout' ? job.stdoutOffset : job.stderrOffset
      const r = readLogTail(path, fromOffset, tailBytes, sinceLast)
      if (sinceLast) {
        if (action === 'stdout') reg.updateOffsets(job.id, r.newOffset, job.stderrOffset)
        else reg.updateOffsets(job.id, job.stdoutOffset, r.newOffset)
      }
      const trunc = truncateTail(r.content, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      })
      const skipped = r.bytesSkipped > 0 ? ` skipped=${r.bytesSkipped}` : ''
      const truncated = trunc.truncated ? ` truncated` : ''
      const header = `[${job.id} ${action} status=${job.status} bytes=${r.bytesRead} file_size=${r.fileSize}${skipped}${truncated}]`
      const body = trunc.content || '(no new output)'
      return { content: [{ type: 'text', text: `${header}\n${body}` }], details: {} }
    },
  })

  pi.registerTool({
    name: 'bash_schedule',
    label: 'Bash (scheduled)',
    description:
      'Run a shell command on a schedule and get woken up when something happens, instead of polling. ' +
      'every="30s" sets the interval between runs (for until: between attempts); ' +
      'until="exit_zero|exit_nonzero|stdout_contains|stderr_contains" retries (with `match` for the ' +
      '*_contains forms) until the condition holds, then stops. ' +
      'notify decides when the agent is messaged: none | on_failure (default for every) | ' +
      'on_success (default for until) | on_match | each. Each run is a normal background job with its own logs. ' +
      'Manage with bash_schedule_manage.',
    promptSnippet: SCHEDULE_PROMPT_SNIPPET,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: 'Shell command to run.' }),
      every: Type.Optional(
        Type.String({
          description: `Interval between runs, e.g. "30s", "5m", "1h30m" (default "${DEFAULT_EVERY}"; "${DEFAULT_UNTIL_INTERVAL}" between until-attempts).`,
        }),
      ),
      until: Type.Optional(
        StringEnum(['exit_zero', 'exit_nonzero', 'stdout_contains', 'stderr_contains'] as const, {
          description:
            'Stop retrying once this holds. exit_zero | exit_nonzero | stdout_contains | stderr_contains.',
        }),
      ),
      match: Type.Optional(
        Type.String({
          description:
            'Regex (or literal fallback) used by the *_contains conditions and by notify=on_match.',
        }),
      ),
      max_attempts: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 10_000,
          description: `Cap on total runs. Default ${DEFAULT_UNTIL_ATTEMPTS} for until; unlimited for every.`,
        }),
      ),
      notify: Type.Optional(
        StringEnum(['none', 'on_failure', 'on_success', 'on_match', 'each'] as const, {
          description:
            'When to wake the agent: none | on_failure | on_success | on_match | each. Default on_failure, or on_success for until.',
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: 'Working directory. Defaults to the session cwd.' }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: 'Per-run hard kill after N seconds.',
          minimum: 1,
          maximum: 86_400,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)
      const { until, match } = params
      // `every` is the interval, `until` the stop condition: passing both is the
      // normal way to say "retry this every N seconds until it succeeds".
      if (until && untilNeedsPattern(until) && !match) {
        throw new Error(`until=${until} needs a \`match\` pattern to look for`)
      }

      const intervalSeconds = parseInterval(
        params.every ?? (until ? DEFAULT_UNTIL_INTERVAL : DEFAULT_EVERY),
      )
      const notify = params.notify ?? (until ? 'on_success' : 'on_failure')
      const common = {
        command: params.command,
        cwd: params.cwd ?? ctx.cwd,
        intervalSeconds,
        matchPattern: match,
        notify,
        timeoutSeconds: params.timeout_seconds,
      }
      const schedule = reg.startSchedule(
        until
          ? {
              ...common,
              mode: 'until',
              untilCondition: until,
              maxAttempts: params.max_attempts ?? DEFAULT_UNTIL_ATTEMPTS,
            }
          : { ...common, mode: 'every', maxAttempts: params.max_attempts },
      )

      const what = until
        ? `until ${describeUntil(until, match)} (every ${formatInterval(intervalSeconds)})`
        : `every ${formatInterval(intervalSeconds)}`
      const maxAttempts = schedule.maxAttempts
      const ignoredMatch = !until && match && notify !== 'on_match'
      const lines = [
        `Scheduled ${schedule.id} ${what}`,
        `  $ ${schedule.command}`,
        `  cwd=${schedule.cwd} notify=${notify}${maxAttempts ? ` max_attempts=${maxAttempts}` : ''}`,
        '  first run started now',
        notify === 'none'
          ? '  no wake-up configured — poll with bash_schedule_manage action=list'
          : '  a message will arrive when it fires; do not poll, keep working',
      ]
      if (ignoredMatch)
        lines.push('  note: `match` is ignored without notify=on_match in every mode')
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} }
    },
  })

  pi.registerTool({
    name: 'bash_schedule_manage',
    label: 'Bash (scheduled) manage',
    description:
      'List, cancel, or trigger-now schedules started with bash_schedule. ' +
      'action=list shows each schedule with mode, run count and next run; ' +
      'action=cancel stops one by id; action=trigger runs it immediately.',
    promptSnippet: SCHEDULE_MANAGE_PROMPT_SNIPPET,
    parameters: Type.Object({
      action: StringEnum(['list', 'cancel', 'trigger'] as const, {
        description: 'What to do: list | cancel | trigger',
      }),
      id: Type.Optional(Type.String({ description: 'Schedule id (required for cancel/trigger).' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)

      if (params.action === 'list') {
        const all = reg.getSchedules()
        if (all.length === 0)
          return { content: [{ type: 'text', text: '(no schedules)' }], details: {} }
        return {
          content: [{ type: 'text', text: all.map(formatSchedule).join('\n') }],
          details: {},
        }
      }

      const id = params.id
      if (!id) throw new Error('`id` is required')
      const schedule = reg.getSchedule(id)
      if (!schedule) throw new Error(`Unknown schedule id: ${id}`)

      const inFlight = schedule.lastJobId ? reg.get(schedule.lastJobId) : undefined
      const inFlightRunning = inFlight?.status === 'running'

      if (params.action === 'cancel') {
        if (schedule.status !== 'active') {
          return {
            content: [
              {
                type: 'text',
                text: `${schedule.id} already ${schedule.status} (${schedule.stoppedReason ?? 'no reason recorded'})`,
              },
            ],
            details: {},
          }
        }
        reg.cancelSchedule(schedule.id)
        const lines = [`Cancelled ${schedule.id} after ${schedule.attempt} run(s).`]
        if (inFlightRunning && inFlight) {
          lines.push(
            `  Its in-flight run ${inFlight.id} (pid=${inFlight.pid}) was left running — kill it with bash_async_manage action=kill id=${inFlight.id}.`,
          )
        }
        return { content: [{ type: 'text', text: lines.join('\n') }], details: {} }
      }

      if (schedule.status !== 'active') {
        throw new Error(`${schedule.id} is ${schedule.status}; start a new schedule instead`)
      }
      reg.triggerSchedule(schedule.id)
      const lines = [`Triggered ${schedule.id} — a run starts now.`]
      if (inFlightRunning && inFlight) {
        lines.push(
          `  Run ${inFlight.id} is still in flight; this trigger will be skipped rather than overlap it.`,
        )
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} }
    },
  })

  pi.registerCommand('jobs', {
    description: 'Open the background-jobs manager (browse, live-tail, kill)',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('Jobs manager needs an interactive UI', 'warning')
        return
      }
      const reg = ensureRegistry(ctx)

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let selected = 0
        let stream: 'stdout' | 'stderr' = 'stdout'
        let notice = ''

        const timer = setInterval(() => tui.requestRender(), MANAGER_POLL_MS)
        function finish() {
          clearInterval(timer)
          done()
        }

        function jobs(): Job[] {
          return reg.getAll()
        }

        function selectedJob(): Job | undefined {
          const all = jobs()
          if (all.length === 0) return undefined
          selected = Math.max(0, Math.min(selected, all.length - 1))
          return all[selected]
        }

        function outputLines(job: Job, width: number): string[] {
          const path = stream === 'stdout' ? job.stdoutPath : job.stderrPath
          const r = readLogTail(path, 0, MANAGER_TAIL_BYTES, false)
          const trunc = truncateTail(r.content, {
            maxLines: MANAGER_OUTPUT_LINES,
            maxBytes: MANAGER_TAIL_BYTES,
          })
          const raw = trunc.content.replace(/\n$/, '')
          if (!raw) return [theme.fg('dim', `  (no ${stream} yet)`)]
          return raw.split('\n').map((l) => `  ${truncateToWidth(l, width - 2)}`)
        }

        function dispatchKeyboardInput(data: string) {
          const all = jobs()
          if (matchesKey(data, Key.escape) || data === 'q') {
            finish()
            return
          }
          if (matchesKey(data, Key.up)) {
            selected = Math.max(0, selected - 1)
          } else if (matchesKey(data, Key.down)) {
            selected = Math.min(Math.max(0, all.length - 1), selected + 1)
          } else if (matchesKey(data, Key.tab) || data === 's') {
            stream = stream === 'stdout' ? 'stderr' : 'stdout'
          } else if (data === 'k') {
            const job = selectedJob()
            if (!job) {
              notice = ''
            } else if (job.status !== 'running') {
              notice = `${job.id} already ${job.status}`
            } else {
              reg.killJob(job.id, 'SIGTERM')
              // Killing the run of a schedule would otherwise just buy one more
              // interval before it comes back — stop the schedule with it.
              const owner = job.scheduleId ? reg.getSchedule(job.scheduleId) : undefined
              if (owner?.status === 'active') {
                reg.cancelSchedule(owner.id)
                notice = `Sent SIGTERM to ${job.id} and cancelled ${owner.id}`
              } else {
                notice = `Sent SIGTERM to ${job.id}`
              }
            }
          } else {
            return
          }
          tui.requestRender()
        }

        function render(width: number): string[] {
          const lines: string[] = []
          const all = jobs()
          const running = all.filter((j) => j.status === 'running').length
          const schedules = reg.getSchedules()
          const activeSchedules = schedules.filter((s) => s.status === 'active').length
          const add = (s: string) => lines.push(truncateToWidth(s, width))

          add(theme.fg('accent', '─'.repeat(width)))
          add(
            theme.fg('accent', theme.bold(' Background jobs ')) +
              theme.fg(
                'muted',
                `${all.length} total · ${running} running · ${activeSchedules}/${schedules.length} schedules active`,
              ),
          )

          if (schedules.length > 0) {
            lines.push('')
            add(theme.fg('accent', ' Schedules '))
            for (const s of schedules) {
              const glyph = theme.fg(SCHEDULE_COLOR[s.status], SCHEDULE_GLYPH[s.status])
              const next =
                s.status === 'active' && s.nextRunAt
                  ? `next ${Math.max(0, Math.round((s.nextRunAt - Date.now()) / 1000))}s`
                  : (s.stoppedReason ?? s.status)
              const what =
                s.mode === 'every'
                  ? `every ${formatInterval(s.intervalSeconds)}`
                  : `until ${describeUntil(s.untilCondition, s.matchPattern)}`
              add(
                `  ${glyph} ${theme.fg('accent', s.id)} ${theme.fg('muted', `${what} · runs=${s.attempt} · ${next}`)}  $ ${truncateToWidth(s.command, Math.max(0, width - 60))}`,
              )
            }
          }

          lines.push('')
          if (all.length === 0) {
            add(theme.fg('dim', '  No background jobs in this session.'))
          } else {
            all.forEach((j, i) => {
              const sel = i === selected
              const glyph = theme.fg(STATUS_COLOR[j.status], STATUS_GLYPH[j.status])
              const exit =
                j.exitCode === undefined || j.exitCode === null ? '' : ` exit=${j.exitCode}`
              const meta = theme.fg('muted', `${j.status}${exit} ${formatDuration(j)}`)
              const cmd = sel ? theme.fg('text', j.command) : theme.fg('dim', j.command)
              const prefix = sel ? theme.fg('accent', '> ') : '  '
              add(`${prefix}${glyph} ${theme.fg(sel ? 'accent' : 'text', j.id)} ${meta}  $ ${cmd}`)
            })
          }

          const job = selectedJob()
          if (job) {
            lines.push('')
            const owner = job.scheduleId ? reg.getSchedule(job.scheduleId) : undefined
            const ownerNote = owner ? theme.fg('muted', ` · ${owner.id} (${owner.status})`) : ''
            const tabFor = (s: 'stdout' | 'stderr') =>
              s === stream
                ? theme.bg('selectedBg', theme.fg('text', ` ${s} `))
                : theme.fg('muted', ` ${s} `)
            add(
              `${theme.fg('dim', ' ── ')}${tabFor('stdout')}${tabFor('stderr')}${theme.fg('dim', ` ── ${job.id} ──`)}${ownerNote}`,
            )
            for (const l of outputLines(job, width)) lines.push(l)
          }

          lines.push('')
          if (notice) add(theme.fg('warning', ` ${notice}`))
          add(
            theme.fg(
              'dim',
              ' ↑↓ select • Tab/s stdout·stderr • k kill • Esc/q close • cancel a schedule: bash_schedule_manage',
            ),
          )
          add(theme.fg('accent', '─'.repeat(width)))
          return lines
        }

        return { render, invalidate: () => {}, handleInput: dispatchKeyboardInput }
      })
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    ensureRegistry(ctx)
  })

  pi.on('session_tree', async (_event, ctx) => {
    // Same session, same jobs — just refresh the status label binding.
    const reg = ensureRegistry(ctx)
    ctx.ui.setStatus('gipi-background', statusLabel(reg))
  })

  // Pi has finished automatic processing: deliver any wake-up that was held
  // back by the coalesce timer so it is not stranded until the next event.
  pi.on('agent_settled', async () => {
    if (pendingEvents.length > 0) {
      try {
        flushCallbacks()
      } catch (err) {
        console.error('[gipi-background] settle flush failed:', err)
      }
    }
  })

  pi.on('session_shutdown', async (event, ctx) => {
    ctx.ui.setStatus('gipi-background', undefined)
    if (!registry || !sessionId) return
    // Timers must not outlive the runtime that owns them, whatever the reason.
    registry.stopTimers()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    pendingEvents.length = 0
    // Only tear down for real exits. Reload/replacement keep the persisted
    // registry on disk so jobs can be re-attached by the next session_start.
    if (event.reason === 'quit') {
      await registry.killAll()
      registry.persist()
      purgeSessionDir(sessionId)
    } else {
      registry.persist()
    }
    registry = undefined
    sessionId = undefined
    lastCtx = undefined
  })
}
