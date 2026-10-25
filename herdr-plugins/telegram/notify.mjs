/**
 * Herdr event hook: `pane.agent_status_changed`.
 *
 * Sends a Telegram message when an agent reaches one of `TELEGRAM_STATES`
 * (default `blocked,done`), unless you are already looking at that pane, and no
 * more than once per cooldown for that pane *and* state.
 *
 * Run with `--test` to send one message regardless of event context, with
 * `--snapshot` to send the whole session, and with `--dry-run` (optionally
 * `--status done` or `--snapshot`) to print the message without sending it.
 *
 * The rules live in `hook.mjs`, which is pure and unit-tested; this file is the
 * wiring between them and Herdr, Telegram and the state file.
 */

import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_QUIET_WHEN_FOCUSED,
  DEFAULT_ROSTER_LIMIT,
  DEFAULT_SILENT_NONBLOCKED,
  DEFAULT_STATES,
  formatMessage,
  formatSnapshot,
  isFocusedPane,
  markNotified,
  markSeen,
  notifyAs,
  overflowsMessage,
  parseStates,
  recentlyNotified,
  replyTarget,
  rosterFromSnapshot,
  silentFor,
} from './hook.mjs'
import {
  envFlag,
  envNumber,
  loadDotEnv,
  messageThreadId,
  paneInfo,
  readJsonEnv,
  readState,
  sendDocument,
  sendMessage,
  sessionSnapshot,
  toast,
  writeState,
} from './lib.mjs'

loadDotEnv()

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (flag('--dry-run')) {
  runDryRun()
} else if (flag('--test')) {
  await runTest()
} else if (flag('--snapshot')) {
  await runSnapshot()
} else {
  await runEvent()
}

function runDryRun() {
  const text = flag('--snapshot') ? snapshotText() : eventText()

  if (text === undefined) {
    process.exitCode = 1
    return
  }

  // The body stays clean for copy-paste; what delivery would do goes to stderr.
  console.log(text)
  const status = flag('--snapshot') ? 'blocked' : (option('--status') ?? 'blocked').toLowerCase()
  console.error(
    `dry-run: silent ${quiet(status)} · document ${overflowsMessage(text)} · ${text.length} chars`,
  )
}

function eventText() {
  const status = (option('--status') ?? 'blocked').toLowerCase()
  const paneId = process.env.HERDR_PANE_ID
  const pane = paneInfo(paneId)
  return formatMessage({
    status,
    pane,
    paneId,
    context: readJsonEnv('HERDR_PLUGIN_CONTEXT_JSON'),
    ...roster(paneId),
  })
}

function snapshotText() {
  const snapshot = sessionSnapshot()
  if (!snapshot) {
    console.error('snapshot unavailable: Herdr did not answer')
    return undefined
  }
  return formatSnapshot(snapshot, {
    limit: envNumber('TELEGRAM_ROSTER_LIMIT', DEFAULT_ROSTER_LIMIT),
  })
}

async function runTest() {
  await attempt(
    [
      '✅ gipi.telegram is wired up',
      `plugin ${process.env.HERDR_PLUGIN_ID ?? '(not run by Herdr)'}`,
      `states ${process.env.TELEGRAM_STATES ?? DEFAULT_STATES}`,
    ].join('\n'),
    { status: 'blocked' },
  )
}

async function runSnapshot() {
  const text = snapshotText()
  if (text === undefined) {
    process.exitCode = 1
    return
  }
  const sent = await attempt(text, { status: 'blocked' })
  if (sent) console.error(`sent snapshot (message ${sent.messageId ?? 'unknown'})`)
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
  const record = (notifiedAs, sent) => {
    const seen = markSeen({ paneState: state.panes[paneId], status, now })
    state.panes[paneId] = notifiedAs
      ? markNotified({
          paneState: seen,
          status: notifiedAs,
          now,
          messageId: sent?.messageId,
          threadId: sent?.threadId,
        })
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
    {
      status: notifiedAs,
      paneState,
    },
  )
  record(sent ? notifiedAs : undefined, sent)
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

/** A block buzzes the phone; a finished turn arrives quietly. */
function quiet(status) {
  return envFlag('TELEGRAM_SILENT_NONBLOCKED', DEFAULT_SILENT_NONBLOCKED) && silentFor(status)
}

/**
 * Send one message: silently unless it is a block, replying into the pane's own
 * thread, and as a document when it would not fit in a message.
 */
async function deliver(text, { status, paneState }) {
  const silent = quiet(status)
  // the topic this pane already posts in, so replies stay where the thread is
  const threadId = messageThreadId() ?? paneState?.lastThreadId

  if (overflowsMessage(text)) {
    return sendDocument({
      text,
      filename: `herdr-${status}.txt`,
      caption: text.split('\n')[0],
      silent,
      threadId,
    })
  }

  return sendMessage({ text, silent, replyTo: replyTarget(paneState), threadId })
}

/**
 * Send, or report why not; a failed send must not be recorded as delivered. The
 * failure also goes to the terminal, because the message that failed was the
 * only thing that would have told you.
 */
async function attempt(text, options) {
  try {
    return await deliver(text, options)
  } catch (error) {
    console.error(error.message)
    toast('Telegram notify failed', error.message)
    process.exitCode = 1
    return undefined
  }
}
