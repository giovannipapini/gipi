/**
 * Behaviour of the notify rules: which pane changes are worth a message, and
 * what that message says. `node --test herdr-plugins/` runs this file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_STATES,
  formatMessage,
  formatSnapshot,
  isFocusedPane,
  isRetryable,
  markNotified,
  markSeen,
  notifyAs,
  overflowsMessage,
  parseStates,
  recentlyNotified,
  replyTarget,
  retryDelayMs,
  rosterFromSnapshot,
  rosterLines,
  silentFor,
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

test('a finished turn notifies whether the agent reports done or goes idle', () => {
  const defaults = parseStates(undefined)
  // integrations that report the end of a turn directly
  assert.equal(notifyAs({ status: 'done', previous: 'working', states: defaults }), 'done')
  // pi reports it as working → idle, which is the same moment
  assert.equal(notifyAs({ status: 'idle', previous: 'working', states: defaults }), 'done')
})

test('an idle that does not follow work stays quiet', () => {
  const defaults = parseStates(undefined)
  assert.equal(notifyAs({ status: 'idle', previous: undefined, states: defaults }), undefined)
  assert.equal(notifyAs({ status: 'idle', previous: 'idle', states: defaults }), undefined)
  assert.equal(notifyAs({ status: 'working', previous: 'idle', states: defaults }), undefined)
})

test('a raw idle still notifies when the states list asks for it', () => {
  const states = parseStates('blocked,idle')
  assert.equal(notifyAs({ status: 'idle', previous: undefined, states }), 'idle')
  // ...but a finished turn is only mapped when `done` is wanted
  assert.equal(notifyAs({ status: 'idle', previous: 'working', states }), 'idle')
  assert.equal(
    notifyAs({ status: 'idle', previous: 'working', states: parseStates('blocked') }),
    undefined,
  )
})

test('blocked and an unknown status pass through as themselves', () => {
  const defaults = parseStates(undefined)
  assert.equal(notifyAs({ status: 'blocked', previous: 'working', states: defaults }), 'blocked')
  assert.equal(notifyAs({ status: 'paused', previous: 'working', states: defaults }), undefined)
  assert.equal(notifyAs({ status: 'paused', previous: 'working', states: ['paused'] }), 'paused')
})

test('a seen status is remembered without touching the notify stamps', () => {
  const before = { done: 2 }
  assert.deepEqual(markSeen({ paneState: before, status: 'working', now: 3 }), {
    done: 2,
    lastStatus: 'working',
    lastSeenAt: 3,
  })
  assert.deepEqual(before, { done: 2 }, 'the input state is not mutated')

  const seen = markSeen({ paneState: before, status: 'idle', now: 4 })
  assert.deepEqual(markNotified({ paneState: seen, status: 'done', now: 5 }), {
    done: 5,
    lastStatus: 'idle',
    lastSeenAt: 4,
  })
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

const snapshot = {
  tabs: [
    { tab_id: 'w1:t1', label: '1', number: 10, pane_count: 1 },
    { tab_id: 'w1:t2', label: '2', number: 11, pane_count: 2 },
    { tab_id: 'w1:t3', label: '3', number: 12, pane_count: 1 },
  ],
  panes: [
    {
      pane_id: 'w1:p1',
      agent: 'pi',
      agent_status: 'idle',
      cwd: '/home/pi/dev/beta',
      tab_id: 'w1:t1',
    },
    {
      pane_id: 'w1:p2',
      agent: 'claude',
      agent_status: 'blocked',
      cwd: '/home/pi/dev/alpha',
      tab_id: 'w1:t2',
    },
    {
      pane_id: 'w1:p3',
      agent: 'pi',
      agent_status: 'working',
      cwd: '/home/pi/dev/gamma',
      tab_id: 'w1:t2',
    },
    {
      pane_id: 'w1:p4',
      agent: '',
      agent_status: 'unknown',
      cwd: '/home/pi/dev/gamma',
      tab_id: 'w1:t3',
    },
    {
      pane_id: 'w1:p9',
      agent: 'pi',
      agent_status: 'working',
      cwd: '/home/pi/dev/self',
      tab_id: 'w1:t3',
    },
  ],
}

test('the roster is the other agents, most urgent first', () => {
  const roster = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  assert.deepEqual(
    roster.map((entry) => `${entry.status}:${entry.agent}@${entry.project}`),
    ['blocked:claude@alpha', 'working:pi@gamma', 'idle:pi@beta'],
    'a shell pane is not an agent, and the pane the message is about is not "other"',
  )
})

test('a pane id is shown only where the location alone repeats', () => {
  assert.deepEqual(rosterLines(rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })), [
    '── other agents · 3 ──',
    '⚠️ claude · alpha · tab 2',
    '⚙️ pi · gamma · tab 2',
    '💤 pi · beta · tab 1',
  ])
})

test('three agents on the same project in different workspaces are told apart by pane id', () => {
  const twins = {
    tabs: [
      { tab_id: 'wH:t1', label: '1', number: 1, pane_count: 1 },
      { tab_id: 'wK:t1', label: '1', number: 1, pane_count: 1 },
      { tab_id: 'wJ:t1', label: '1', number: 1, pane_count: 1 },
    ],
    panes: [
      {
        pane_id: 'wH:p1',
        agent: 'pi',
        agent_status: 'working',
        cwd: '/home/pi/dev/dotfiles',
        tab_id: 'wH:t1',
      },
      {
        pane_id: 'wK:p1',
        agent: 'pi',
        agent_status: 'working',
        cwd: '/home/pi/dev/dotfiles',
        tab_id: 'wK:t1',
      },
      {
        pane_id: 'wJ:p1',
        agent: 'claude',
        agent_status: 'idle',
        cwd: '/home/pi/dev/dotfiles',
        tab_id: 'wJ:t1',
      },
    ],
  }
  assert.deepEqual(rosterLines(rosterFromSnapshot(twins, {})), [
    '── other agents · 3 ──',
    '⚙️ pi · dotfiles · tab 1 · wH:p1',
    '⚙️ pi · dotfiles · tab 1 · wK:p1',
    '💤 claude · dotfiles · tab 1 · wJ:p1',
  ])
})

test('a long roster is capped and names what it dropped', () => {
  const entries = rosterFromSnapshot(snapshot, {})
  assert.equal(entries.length, 4)
  assert.deepEqual(rosterLines(entries, { limit: 2 }).at(-1), '+2 more')
})

test('the header counts the roster, not the visible slice', () => {
  const entries = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  assert.equal(rosterLines(entries, { limit: 1 })[0], '── other agents · 3 ──')
})

test('one agent reads as one agent', () => {
  const [entry] = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  assert.equal(rosterLines([entry])[0], '── other agent · 1 ──')
})

test('the roster can be switched off, and an empty session shows none', () => {
  const entries = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  assert.deepEqual(rosterLines(entries, { limit: 0 }), [])
  assert.deepEqual(rosterLines([], {}), [])
})

test('the first line carries how many agents are waiting on you', () => {
  const others = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  const text = formatMessage({ status: 'done', pane, context, paneId: 'w1:p9', others })
  assert.equal(text.split('\n')[0], '✅ pi finished · 1 waiting')
  assert.ok(text.includes('── other agents · 3 ──'))
})

test('hiding the roster keeps the waiting count', () => {
  const others = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  const text = formatMessage({
    status: 'done',
    pane,
    context,
    paneId: 'w1:p9',
    others,
    rosterLimit: 0,
  })
  assert.equal(text.split('\n')[0], '✅ pi finished · 1 waiting')
  assert.equal(text.includes('──'), false)
})

test('with nobody waiting the first line stays inside the 29-character budget', () => {
  const others = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' }).filter(
    (e) => e.status !== 'blocked',
  )
  const text = formatMessage({ status: 'blocked', pane, context, paneId: 'w1:p1', others })
  assert.equal(text.split('\n')[0], '⚠️ pi is waiting for you')
  assert.ok(text.split('\n')[0].length < 29)
})

test('only a blocked agent buzzes the phone', () => {
  assert.equal(silentFor('blocked'), false)
  assert.equal(silentFor('done'), true)
  assert.equal(silentFor('idle'), true)
  assert.equal(silentFor('paused'), true)
})

test('a message over the Telegram cap goes as a document instead', () => {
  assert.equal(overflowsMessage('x'.repeat(4096)), false)
  assert.equal(overflowsMessage('x'.repeat(4097)), true)
  assert.equal(overflowsMessage('xxxx', 4), false)
  assert.equal(overflowsMessage('xxxxx', 4), true)
})

test('a rate limit or a 5xx retries, a rejected token does not', () => {
  assert.equal(isRetryable({ status: 429 }), true)
  assert.equal(isRetryable({ status: 503 }), true)
  assert.equal(isRetryable({ network: true }), true)
  assert.equal(isRetryable({ status: 400 }), false)
  assert.equal(isRetryable({ status: 401 }), false)
  assert.equal(isRetryable({ status: 403 }), false)
})

test('the wait honours retry_after, else backs off from one second', () => {
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 7 }), 7_000)
  assert.equal(retryDelayMs({ attempt: 1 }), 1_000)
  assert.equal(retryDelayMs({ attempt: 2 }), 2_000)
  assert.equal(retryDelayMs({ attempt: 3 }), 4_000)
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 0 }), 1_000)
})

test('a sent message becomes the next one’s reply target', () => {
  const sent = markNotified({ status: 'blocked', now: NOW, messageId: 41, threadId: 7 })
  assert.equal(replyTarget(sent), 41)
  assert.deepEqual(
    { lastMessageId: sent.lastMessageId, lastThreadId: sent.lastThreadId },
    { lastMessageId: 41, lastThreadId: 7 },
  )
  assert.equal(replyTarget(undefined), undefined)
  assert.equal(replyTarget({ blocked: 1 }), undefined)
})

test('a status change keeps the thread it replies into', () => {
  const sent = markNotified({ status: 'blocked', now: NOW, messageId: 41 })
  const seen = markSeen({ paneState: sent, status: 'working', now: NOW + 1 })
  assert.equal(replyTarget(seen), 41)
  assert.equal(seen.lastStatus, 'working')
})

test('the roster label is the caller’s, so a snapshot is not "other"', () => {
  const entries = rosterFromSnapshot(snapshot, { excludePaneId: 'w1:p9' })
  assert.equal(rosterLines(entries, { label: 'agent' })[0], '── agents · 3 ──')
  assert.equal(rosterLines(entries)[0], '── other agents · 3 ──')
  assert.equal(rosterLines(entries, { header: false })[0], '⚠️ claude · alpha · tab 2')
})

test('a snapshot is the whole session, most urgent first', () => {
  const text = formatSnapshot(snapshot, { limit: 2 }).split('\n')
  assert.equal(text[0], '📋 4 agents · 1 waiting')
  assert.equal(text[1], '⚠️ claude · alpha · tab 2')
  assert.equal(text[3], '+2 more')
  assert.equal(text.includes('──'), false, 'the first line already counts them')
})

test('an empty session says so instead of sending an empty list', () => {
  assert.equal(formatSnapshot({ panes: [], tabs: [] }), '💤 no agents running')
  assert.equal(formatSnapshot(undefined), '💤 no agents running')
})
