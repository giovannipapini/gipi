/**
 * Herdr event hook: `pane.agent_status_changed`.
 *
 * Sends a Telegram message when an agent reaches one of `TELEGRAM_STATES`
 * (default `blocked`), unless you are already looking at that pane.
 *
 * Quiet rules, in order:
 *   1. only configured states notify (`TELEGRAM_STATES`);
 *   2. skip when the changed pane is the focused pane (`TELEGRAM_QUIET_WHEN_FOCUSED`,
 *      default on) — Herdr reports focus on the pane itself, so no guessing;
 *   3. per-pane cooldown, so a prompt that re-blocks in a loop cannot spam
 *      (`TELEGRAM_COOLDOWN_SECONDS`, default 120, 0 disables).
 *
 * Run with `--test` to send one message regardless of event context, and with
 * `--dry-run` (optionally `--status done`) to print the formatted message without
 * sending it.
 */

import {
  envFlag,
  envNumber,
  loadDotEnv,
  paneInfo,
  readJsonEnv,
  readState,
  sendTelegram,
  writeState,
} from './lib.mjs'

/**
 * First line per state: what happened, in the user's terms. `{agent}` is whatever
 * Herdr reports for the pane (`pi`, `claude`, `codex`, …), kept as reported — no
 * title-casing, so it matches the label in the sidebar.
 */
const HEADLINE = {
  blocked: '⚠️ {agent} is waiting for you',
  done: '✅ {agent} finished',
  idle: '💤 {agent} went idle',
  working: '⚙️ {agent} started working',
}

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
  const pane = paneInfo(process.env.HERDR_PANE_ID)
  console.log(formatMessage({ status, pane, context: readJsonEnv('HERDR_PLUGIN_CONTEXT_JSON') }))
}

async function runTest() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) fail('missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
  await attempt(
    [
      '✅ gipi.telegram-notify is wired up',
      `plugin ${process.env.HERDR_PLUGIN_ID ?? '(not run by Herdr)'}`,
      `states ${process.env.TELEGRAM_STATES ?? 'blocked'}`,
    ].join('\n'),
  )
}

async function runEvent() {
  const event = readJsonEnv('HERDR_PLUGIN_EVENT_JSON')
  const context = readJsonEnv('HERDR_PLUGIN_CONTEXT_JSON')
  const data = event?.data ?? {}
  const status = String(data.agent_status ?? '').toLowerCase()
  const states = parseStates(process.env.TELEGRAM_STATES)

  if (!states.includes(status)) process.exit(0)

  const paneId = data.pane_id ?? process.env.HERDR_PANE_ID
  const pane = paneInfo(paneId)

  if (envFlag('TELEGRAM_QUIET_WHEN_FOCUSED', true) && isWatched(pane, context, paneId)) {
    console.error(`skip: ${paneId} is focused`)
    process.exit(0)
  }

  const cooldown = envNumber('TELEGRAM_COOLDOWN_SECONDS', 120)
  if (cooldown > 0 && recentlyNotified(paneId, cooldown)) {
    console.error(`skip: ${paneId} notified less than ${cooldown}s ago`)
    process.exit(0)
  }

  await attempt(formatMessage({ status, pane, context, paneId }))
  markNotified(paneId)
}

function parseStates(raw) {
  const states = String(raw ?? 'blocked')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return states.length > 0 ? states : ['blocked']
}

/** Focus comes from the pane snapshot; the context JSON is only a fallback. */
function isWatched(pane, context, paneId) {
  if (typeof pane?.focused === 'boolean') return pane.focused
  const focused = context?.focused_pane_id ?? context?.focused_pane?.pane_id
  return typeof focused === 'string' && focused === paneId
}

function formatMessage({ status, pane, context, paneId }) {
  const agent = agentLabel(pane, context)
  const headline = (HEADLINE[status] ?? '🔔 {agent} is {status}').replace('{agent}', agent)
  const cwd = compactHome(pane?.cwd ?? pane?.foreground_cwd ?? context?.focused_pane_cwd)
  const title = terminalTitle(pane, cwd)

  return [
    headline,
    herdrReference({ pane, context, paneId }),
    [title, cwd].filter(Boolean).join(' · '),
  ]
    .filter(Boolean)
    .join('\n')
}

/** Where to look: a copy-pasteable path through the Herdr session. */
function herdrReference({ pane, context, paneId }) {
  const workspace = context?.workspace_label ?? pane?.workspace_id
  const tab = context?.tab_label ?? pane?.tab_id
  const parts = [
    'herdr',
    workspace,
    tab === undefined ? undefined : `tab ${tab}`,
    paneId ?? pane?.pane_id,
  ]
  return `▸ ${parts.filter(Boolean).join(' · ')}`
}

/** Drop a shell-style `user@host:/path` title that only repeats the cwd. */
function terminalTitle(pane, cwd) {
  const title = firstLine(pane?.terminal_title_stripped ?? pane?.terminal_title)
  if (!title || !cwd) return title
  const base = cwd.split('/').at(-1)
  return title.includes(cwd) || (base && title.endsWith(base)) ? undefined : title
}

function compactHome(path) {
  const text = String(path ?? '').trim()
  const home = process.env.HOME
  if (home && text.startsWith(home)) return `~${text.slice(home.length)}`
  return text || undefined
}

/** Herdr's own agent label, verbatim and lowercase; never a hardcoded name. */
function agentLabel(pane, context) {
  const raw = pane?.agent ?? context?.focused_pane_agent ?? ''
  return String(raw).trim().toLowerCase() || 'an agent'
}

/** Whitespace-collapsed and clamped to one readable line. */
function firstLine(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`
}

function recentlyNotified(paneId, cooldownSeconds) {
  const last = readState()?.panes?.[paneId]?.lastNotifiedAt
  return typeof last === 'number' && Date.now() - last < cooldownSeconds * 1000
}

function markNotified(paneId) {
  const state = readState()
  state.panes = state.panes ?? {}
  state.panes[paneId] = { lastNotifiedAt: Date.now() }
  writeState(state)
}

async function attempt(text) {
  try {
    await sendTelegram(text)
  } catch (error) {
    fail(error.message)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
