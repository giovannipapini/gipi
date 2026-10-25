/**
 * Herdr event hook: `pane.agent_status_changed`.
 *
 * Sends a Telegram message when an agent reaches one of `TELEGRAM_STATES`
 * (default `blocked,done`), unless you are already looking at that pane, and no
 * more than once per cooldown for that pane *and* state.
 *
 * Run with `--test` to send one message regardless of event context, and with
 * `--dry-run` (optionally `--status done`) to print the formatted message
 * without sending it.
 *
 * The rules live in `hook.mjs`, which is pure and unit-tested; this file is the
 * wiring between them and Herdr, Telegram and the state file.
 */

import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_QUIET_WHEN_FOCUSED,
  DEFAULT_ROSTER_LIMIT,
  DEFAULT_STATES,
  formatMessage,
  isFocusedPane,
  markNotified,
  markSeen,
  notifyAs,
  parseStates,
  recentlyNotified,
  rosterFromSnapshot,
} from './hook.mjs'
import {
  envFlag,
  envNumber,
  loadDotEnv,
  paneInfo,
  readJsonEnv,
  readState,
  sendTelegram,
  sessionSnapshot,
  writeState,
} from './lib.mjs'

loadDotEnv()

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (flag('--test')) {
  await runTest()
} else if (flag('--dry-run')) {
  runDryRun()
} else {
  await runEvent()
}

function runDryRun() {
  const status = (option('--status') ?? 'blocked').toLowerCase()
  const paneId = process.env.HERDR_PANE_ID
  const pane = paneInfo(paneId)
  console.log(
    formatMessage({
      status,
      pane,
      paneId,
      context: readJsonEnv('HERDR_PLUGIN_CONTEXT_JSON'),
      ...roster(paneId),
    }),
  )
}

async function runTest() {
  await attempt(
    [
      '✅ gipi.telegram is wired up',
      `plugin ${process.env.HERDR_PLUGIN_ID ?? '(not run by Herdr)'}`,
      `states ${process.env.TELEGRAM_STATES ?? DEFAULT_STATES}`,
    ].join('\n'),
  )
}

async function runEvent() {
  const context = readJsonEnv('HERDR_PLUGIN_CONTEXT_JSON')
  const data = readJsonEnv('HERDR_PLUGIN_EVENT_JSON').data ?? {}
  const status = String(data.agent_status ?? '').toLowerCase()
  const paneId = data.pane_id ?? process.env.HERDR_PANE_ID

  const now = Date.now()
  const state = readState()
  state.panes = state.panes ?? {}
  const paneState = state.panes[paneId]
  const previous = paneState?.lastStatus
  // Herdr re-publishes the same status on a reload; that is not a change
  if (previous === status) return

  // every path below records the status, so the next event can tell a finished
  // turn (working → idle) from a session that was already idle
  const record = (notifiedAs) => {
    const seen = markSeen({ paneState: state.panes[paneId], status, now })
    state.panes[paneId] = notifiedAs
      ? markNotified({ paneState: seen, status: notifiedAs, now })
      : seen
    writeState(state)
  }

  const notifiedAs = notifyAs({
    status,
    previous,
    states: parseStates(process.env.TELEGRAM_STATES),
  })
  if (!notifiedAs) {
    record()
    return skip(`${status} is not a notify state (previous ${previous ?? 'none'})`)
  }

  const pane = paneInfo(paneId)

  const quiet = envFlag('TELEGRAM_QUIET_WHEN_FOCUSED', DEFAULT_QUIET_WHEN_FOCUSED)
  if (quiet && isFocusedPane(pane, context, paneId)) {
    record()
    return skip(`${paneId} is focused`)
  }

  const cooldown = envNumber('TELEGRAM_COOLDOWN_SECONDS', DEFAULT_COOLDOWN_SECONDS)
  if (
    cooldown > 0 &&
    recentlyNotified({ paneState, status: notifiedAs, cooldownSeconds: cooldown, now })
  ) {
    record()
    return skip(`${paneId} notified ${notifiedAs} less than ${cooldown}s ago`)
  }

  const sent = await attempt(
    formatMessage({ status: notifiedAs, pane, context, paneId, ...roster(paneId) }),
  )
  record(sent ? notifiedAs : undefined)
}

/**
 * The other agents in the session, for the roster below the message. A missing
 * snapshot costs the roster, never the notification itself.
 */
function roster(excludePaneId) {
  const snapshot = sessionSnapshot()
  if (!snapshot) console.error('roster unavailable: no session snapshot')

  return {
    others: snapshot ? rosterFromSnapshot(snapshot, { excludePaneId }) : [],
    rosterLimit: envNumber('TELEGRAM_ROSTER_LIMIT', DEFAULT_ROSTER_LIMIT),
  }
}

function skip(reason) {
  console.error(`skip: ${reason}`)
}

/** Send, or report why not; a failed send must not be recorded as delivered. */
async function attempt(text) {
  try {
    await sendTelegram(text)
    return true
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return false
  }
}
