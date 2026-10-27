/**
 * Schedule math, testable without a session: `pnpm test` (node --test).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampInterval,
  describeUntil,
  evaluateUntil,
  formatInterval,
  MAX_INTERVAL_SECONDS,
  matchesPattern,
  nextRunAt,
  parseInterval,
  shouldNotify,
  untilNeedsPattern,
} from './schedule.ts'

test('intervals parse from bare seconds and compound units', () => {
  assert.equal(parseInterval(30), 30)
  assert.equal(parseInterval('30'), 30)
  assert.equal(parseInterval('30s'), 30)
  assert.equal(parseInterval('5m'), 300)
  assert.equal(parseInterval('1h30m'), 5400)
  assert.equal(parseInterval('2d'), MAX_INTERVAL_SECONDS, '2d is over the 24h ceiling')
  assert.equal(parseInterval(' 10 S '), 10)
})

test('sub-second intervals clamp up to the 1s floor instead of forking wildly', () => {
  assert.equal(parseInterval('500ms'), 1)
  assert.equal(parseInterval(0.2), 1)
})

test('intervals above the ceiling clamp down to 24h', () => {
  assert.equal(parseInterval('30d'), MAX_INTERVAL_SECONDS)
  assert.equal(clampInterval(1e9), MAX_INTERVAL_SECONDS)
})

test('malformed intervals throw rather than silently becoming something else', () => {
  assert.throws(() => parseInterval('5 minutes'), /could not parse/)
  assert.throws(() => parseInterval('1h30'), /could not parse/)
  assert.throws(() => parseInterval('soon'), /could not parse/)
  assert.throws(() => parseInterval('  '), /empty/)
  assert.throws(() => parseInterval(-5), /positive/)
  assert.throws(() => parseInterval(Number.NaN), /positive/)
})

test('intervals format back compactly', () => {
  assert.equal(formatInterval(45), '45s')
  assert.equal(formatInterval(60), '1m')
  assert.equal(formatInterval(300), '5m')
  assert.equal(formatInterval(5400), '1h30m')
  assert.equal(formatInterval(3600), '1h')
  assert.equal(formatInterval(86_400), '1d')
})

test('the next run is now plus the interval', () => {
  assert.equal(nextRunAt(1000, 30), 31_000)
  assert.equal(nextRunAt(1000, 1.4), 2400)
})

test('only *_contains conditions need a pattern', () => {
  assert.equal(untilNeedsPattern('stdout_contains'), true)
  assert.equal(untilNeedsPattern('stderr_contains'), true)
  assert.equal(untilNeedsPattern('exit_zero'), false)
  assert.equal(untilNeedsPattern('exit_nonzero'), false)
  assert.equal(describeUntil('stdout_contains', 'ready'), 'stdout contains ready')
  assert.equal(describeUntil('exit_zero'), 'exit code 0')
})

test('patterns match as regex and degrade to substrings when invalid', () => {
  assert.equal(matchesPattern('server listening on 3000', 'listening on \\d+'), true)
  assert.equal(matchesPattern('server listening on 3000', '^listening'), false)
  assert.equal(matchesPattern('listening\non', '^on$'), true, 'multiline anchors work')
  assert.equal(matchesPattern('listening on :3000 (dev', '(dev'), true, 'invalid regex → substring')
  assert.equal(matchesPattern('listening on :3000', 'not-here'), false)
  assert.equal(matchesPattern('', 'x'), false)
  assert.equal(matchesPattern('x', ''), false)
})

test('until conditions read exit codes and output', () => {
  assert.equal(evaluateUntil('exit_zero', { exitCode: 0 }), true)
  assert.equal(evaluateUntil('exit_zero', { exitCode: 1 }), false)
  assert.equal(evaluateUntil('exit_zero', { exitCode: null }), false)
  assert.equal(evaluateUntil('exit_nonzero', { exitCode: 2 }), true)
  assert.equal(evaluateUntil('exit_nonzero', { exitCode: 0 }), false)
  assert.equal(evaluateUntil('exit_nonzero', { exitCode: null }), false, 'null is not an exit code')
  assert.equal(evaluateUntil('stdout_contains', { stdout: 'ready', matchPattern: 'ready' }), true)
  assert.equal(
    evaluateUntil('stdout_contains', { stdout: 'ready' }),
    false,
    'no pattern → no match',
  )
  assert.equal(evaluateUntil('stderr_contains', { stderr: 'boom', matchPattern: 'boom' }), true)
  assert.equal(
    evaluateUntil('stderr_contains', { stdout: 'boom', matchPattern: 'boom' }),
    false,
    'streams are not mixed',
  )
})

test('notification routing is per trigger kind', () => {
  assert.equal(shouldNotify('none', 'success'), false)
  assert.equal(shouldNotify('none', 'failure'), false)
  assert.equal(shouldNotify('each', 'success'), true)
  assert.equal(shouldNotify('each', 'failure'), true)
  assert.equal(shouldNotify('each', 'match'), true)
  assert.equal(shouldNotify('on_success', 'success'), true)
  assert.equal(shouldNotify('on_success', 'failure'), false)
  assert.equal(shouldNotify('on_failure', 'failure'), true)
  assert.equal(shouldNotify('on_failure', 'success'), false)
  assert.equal(shouldNotify('on_match', 'match'), true)
  assert.equal(shouldNotify('on_match', 'success'), false)
})
