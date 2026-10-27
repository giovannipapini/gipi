/**
 * Schedule math for gipi-background — intervals, `until` conditions, and
 * notification routing.
 *
 * Pure and side-effect free (no pi, no node imports): everything here is unit
 * testable in isolation (`lib/schedule.test.ts`), and `jobs.ts` stays free of
 * parsing rules. Only type imports cross into the extension.
 *
 * Usage:
 *   import { parseInterval, evaluateUntil, shouldNotify } from '../../lib/schedule.js'
 *
 *   const seconds = parseInterval('5m')        // 300
 *   const done = evaluateUntil('stdout_contains', { exitCode: 0, stdout, stderr, matchPattern: 'ready' })
 *   const wake = shouldNotify('on_failure', 'failure')
 */

import type { ScheduleNotify, UntilCondition } from '../pi-extensions/gipi-background/types.js'

/** A 1s floor keeps a bad `every: "1ms"` from becoming a fork bomb. */
export const MIN_INTERVAL_SECONDS = 1

/** Matches the 24h ceiling of `bash_async`'s timeout_seconds. */
export const MAX_INTERVAL_SECONDS = 86_400

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 }

const UNIT_TOKEN = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g

/** Clamp a raw seconds value into the supported range. */
export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`interval must be a positive number of seconds, got ${seconds}`)
  }
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)))
}

/**
 * Parse an interval into whole seconds.
 *
 * Accepts a bare number (seconds) or a compound string: `30`, `30s`, `5m`,
 * `1h30m`, `2d`. Values below 1s clamp to 1s, above 24h clamp to 24h.
 */
export function parseInterval(input: string | number): number {
  if (typeof input === 'number') return clampInterval(input)
  const raw = input.trim().toLowerCase()
  if (!raw) throw new Error('interval is empty — use e.g. "30s", "5m", "1h30m"')
  if (/^\d+(?:\.\d+)?$/.test(raw)) return clampInterval(Number(raw))

  let total = 0
  for (const m of raw.matchAll(UNIT_TOKEN)) total += Number(m[1]) * UNIT_SECONDS[m[2]]
  if (total === 0) throw new Error(`could not parse interval "${input}" — use e.g. "30s", "5m"`)
  // Anything the unit regex did not consume means the string is malformed:
  // "5 minutes", "5x", "1h30" must not silently become 5s / 1h.
  if (raw.replace(UNIT_TOKEN, '').trim() !== '') {
    throw new Error(`could not parse interval "${input}" — use units ms|s|m|h|d, e.g. "90s"`)
  }
  return clampInterval(total)
}

/** Render seconds back as a compact human interval (`45s`, `5m`, `1h30m`). */
export function formatInterval(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const units: Array<[string, number]> = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
  ]
  const parts: string[] = []
  let rest = s
  for (const [label, size] of units) {
    const n = Math.floor(rest / size)
    if (n > 0) {
      parts.push(`${n}${label}`)
      rest -= n * size
    }
  }
  if (rest > 0) parts.push(`${rest}s`)
  return parts.join('')
}

/** Epoch ms of the run after `now`, given the interval in seconds. */
export function nextRunAt(now: number, intervalSeconds: number): number {
  return now + Math.round(intervalSeconds * 1000)
}

/** `*_contains` conditions are meaningless without a pattern to look for. */
export function untilNeedsPattern(condition: UntilCondition): boolean {
  return condition === 'stdout_contains' || condition === 'stderr_contains'
}

/** Human description of an `until` condition, e.g. `stdout contains /ready/`. */
export function describeUntil(condition: UntilCondition, pattern?: string): string {
  switch (condition) {
    case 'exit_zero':
      return 'exit code 0'
    case 'exit_nonzero':
      return 'non-zero exit code'
    case 'stdout_contains':
      return `stdout contains ${pattern ?? '(missing pattern)'}`
    case 'stderr_contains':
      return `stderr contains ${pattern ?? '(missing pattern)'}`
  }
}

/**
 * Regex match with a literal-substring fallback.
 *
 * A pattern the model wrote as prose (`listening on :3000`) must not throw and
 * silently kill the tick, so an invalid regex degrades to `String.includes`.
 */
export function matchesPattern(text: string, pattern: string): boolean {
  if (!text || !pattern) return false
  try {
    return new RegExp(pattern, 'm').test(text)
  } catch {
    return text.includes(pattern)
  }
}

export interface UntilResult {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  matchPattern?: string
}

/** Whether one finished run satisfies the schedule's stopping condition. */
export function evaluateUntil(condition: UntilCondition, result: UntilResult): boolean {
  switch (condition) {
    case 'exit_zero':
      return result.exitCode === 0
    case 'exit_nonzero':
      return typeof result.exitCode === 'number' && result.exitCode !== 0
    case 'stdout_contains':
      return matchesPattern(result.stdout ?? '', result.matchPattern ?? '')
    case 'stderr_contains':
      return matchesPattern(result.stderr ?? '', result.matchPattern ?? '')
  }
}

/**
 * Route one finished run to a notification decision.
 *
 * `tick` (any completed run) is the synthetic kind used by `each`; `success` and
 * `failure` are mutually exclusive, while `match` is independent of both.
 */
export function shouldNotify(
  notify: ScheduleNotify,
  kind: 'success' | 'failure' | 'match' | 'tick',
): boolean {
  switch (notify) {
    case 'none':
      return false
    case 'each':
      return true
    case 'on_success':
      return kind === 'success'
    case 'on_failure':
      return kind === 'failure'
    case 'on_match':
      return kind === 'match'
  }
}
