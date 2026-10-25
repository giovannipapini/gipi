/**
 * Behaviour of the notify rules: which pane changes are worth a message, and
 * what that message says. `node --test herdr-plugins/` runs this file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_STATES,
  formatMessage,
  isFocusedPane,
  markNotified,
  parseStates,
  recentlyNotified,
} from './hook.mjs'

const pane = {
  agent: 'pi',
  cwd: '/home/pi/dev/github/gipi',
  terminal_title_stripped: 'pi-agent (telegram notify)',
}
const context = { workspace_label: 'pi', tab_label: '1', focused_pane_id: 'w8:p1' }
const NOW = 1_000_000
const COOLDOWN = 120

test('states fall back to the defaults when unset or blank', () => {
  assert.deepEqual(parseStates(undefined), DEFAULT_STATES.split(','))
  assert.deepEqual(parseStates('   '), ['blocked', 'done'])
  assert.deepEqual(parseStates(',,'), ['blocked', 'done'])
})

test('states are trimmed and matched case-insensitively', () => {
  assert.deepEqual(parseStates(' Blocked , DONE ,idle '), ['blocked', 'done', 'idle'])
})

test('a finished pane does not mute the block that follows it', () => {
  const paneState = markNotified({ status: 'done', now: NOW })
  const soon = NOW + 1_000
  assert.equal(
    recentlyNotified({ paneState, status: 'done', cooldownSeconds: COOLDOWN, now: soon }),
    true,
  )
  assert.equal(
    recentlyNotified({ paneState, status: 'blocked', cooldownSeconds: COOLDOWN, now: soon }),
    false,
  )
})

test('the cooldown expires, and an unknown pane is never throttled', () => {
  const paneState = markNotified({ status: 'blocked', now: NOW })
  const later = NOW + COOLDOWN * 1_000
  assert.equal(
    recentlyNotified({ paneState, status: 'blocked', cooldownSeconds: COOLDOWN, now: later }),
    false,
  )
  assert.equal(
    recentlyNotified({
      paneState: undefined,
      status: 'blocked',
      cooldownSeconds: COOLDOWN,
      now: NOW,
    }),
    false,
  )
})

test('recording one status keeps the others and drops the pre-0.2 stamp', () => {
  const before = { lastNotifiedAt: 1, blocked: 2 }
  assert.deepEqual(markNotified({ paneState: before, status: 'done', now: 3 }), {
    blocked: 2,
    done: 3,
  })
  assert.deepEqual(before, { lastNotifiedAt: 1, blocked: 2 }, 'the input state is not mutated')
})

test('the pane snapshot outranks the event context on focus', () => {
  assert.equal(isFocusedPane({ focused: false }, context, 'w8:p1'), false)
  assert.equal(isFocusedPane({ focused: true }, { focused_pane_id: 'w8:p9' }, 'w8:p1'), true)
})

test('focus falls back to the context for a pane that is already gone', () => {
  assert.equal(isFocusedPane(undefined, context, 'w8:p1'), true)
  assert.equal(isFocusedPane(undefined, { focused_pane: { pane_id: 'w8:p2' } }, 'w8:p1'), false)
  assert.equal(isFocusedPane(undefined, {}, 'w8:p1'), false)
})

test('blocked and done read differently but share the location and title', () => {
  const lines = (status) =>
    formatMessage({ status, pane, context, paneId: 'w8:p1', home: '/home/pi' }).split('\n')

  assert.equal(lines('blocked')[0], '⚠️ pi is waiting for you')
  assert.equal(lines('done')[0], '✅ pi finished')
  assert.equal(lines('blocked')[1], '▸ herdr · pi · tab 1 · w8:p1')
  assert.equal(lines('done')[2], 'pi-agent (telegram notify) · ~/dev/github/gipi')
})

test('a state we have no wording for is spelled out, never left as a placeholder', () => {
  const text = formatMessage({ status: 'paused', pane, context, paneId: 'w8:p1' })
  assert.equal(text.split('\n')[0], '🔔 pi is paused')
})

test('a pane without an agent still reads as a sentence', () => {
  const lines = formatMessage({ status: 'blocked', pane: {}, context: {}, paneId: 'w8:p9' }).split(
    '\n',
  )
  assert.equal(lines[0], '⚠️ an agent is waiting for you')
  assert.equal(lines[1], '▸ herdr · w8:p9')
  assert.equal(lines.length, 2, 'no empty title/cwd line')
})

test('a shell title that only repeats the cwd is dropped', () => {
  const text = formatMessage({
    status: 'done',
    pane: { ...pane, terminal_title_stripped: 'pi@host: /home/pi/dev/github/gipi' },
    context,
    paneId: 'w8:p1',
    home: '/home/pi',
  })
  assert.equal(text.split('\n')[2], '~/dev/github/gipi')
})

test('a long title is clamped to one readable line', () => {
  const text = formatMessage({
    status: 'done',
    pane: { ...pane, terminal_title_stripped: 'x'.repeat(200) },
    context,
    paneId: 'w8:p1',
  })
  const title = text.split('\n')[2].split(' · ')[0]
  assert.equal(title.length, 80)
  assert.ok(title.endsWith('…'))
})
