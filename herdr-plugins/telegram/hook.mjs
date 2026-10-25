/**
 * Telegram notify policy: which pane statuses are worth a message, and what
 * that message says.
 *
 * Every function here is pure — the state file, the clock and the pane snapshot
 * arrive as arguments — so the rules can be tested without Herdr, a socket or a
 * network. `notify.mjs` owns all of that I/O.
 */

/**
 * States that notify when `TELEGRAM_STATES` is unset. `blocked` needs you now;
 * `done` is what makes it safe to look away in the first place (for an integration
 * that reports no `done`, `notifyAs` reads its `working` → `idle` as one).
 */
export const DEFAULT_STATES = 'blocked,done'

/** Per-pane, per-state quiet period in seconds; `0` disables it. */
export const DEFAULT_COOLDOWN_SECONDS = 120

/** Stay silent while you are looking at the pane that changed. */
export const DEFAULT_QUIET_WHEN_FOCUSED = true

/** Roster lines shown by default; `0` leaves the roster out entirely. */
export const DEFAULT_ROSTER_LIMIT = 5

/** Beyond this a terminal title stops being a hint and becomes noise. */
const TITLE_LIMIT = 80

/**
 * First line per state: what happened, in the user's terms. `agent` is whatever
 * Herdr reports for the pane (`pi`, `claude`, `codex`, …), kept as reported — no
 * title-casing, so it matches the label in the sidebar.
 */
const HEADLINE = {
  blocked: (agent) => `⚠️ ${agent} is waiting for you`,
  done: (agent) => `✅ ${agent} finished`,
  idle: (agent) => `💤 ${agent} went idle`,
  working: (agent) => `⚙️ ${agent} started working`,
}

/**
 * Roster order: what you have to look at first, then what you only want to know.
 * The icon is the only per-state decoration — Material's guidance is sparse emoji,
 * words doing the work.
 */
const ROSTER = {
  blocked: { icon: '⚠️', rank: 0 },
  done: { icon: '✅', rank: 1 },
  working: { icon: '⚙️', rank: 2 },
  idle: { icon: '💤', rank: 3 },
}
const ROSTER_FALLBACK = { icon: '·', rank: 4 }

/**
 * `TELEGRAM_STATES` as a normalised list. A blank setting means the defaults,
 * never "notify on nothing".
 */
export function parseStates(raw) {
  const states = String(raw ?? DEFAULT_STATES)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return states.length > 0 ? states : DEFAULT_STATES.split(',')
}

/**
 * The status to notify as, or `undefined` to stay quiet.
 *
 * Herdr's `done` means "finished turn", but only some integrations report it: pi
 * reports the same moment as `working` → `idle`, so that transition counts as the
 * `done` the states list asks for. A plain `idle` still notifies for anyone who
 * lists it (a session start or a reload that was already idle).
 */
export function notifyAs({ status, previous, states }) {
  if (states.includes(status)) return status
  if (status === 'idle' && previous === 'working' && states.includes('done')) return 'done'
  return undefined
}

/**
 * Whether you are looking at the pane that changed. The pane snapshot decides
 * when it has an opinion; the event context is a fallback for a pane that has
 * already gone.
 */
export function isFocusedPane(pane, context, paneId) {
  if (typeof pane?.focused === 'boolean') return pane.focused
  const focused = context?.focused_pane_id ?? context?.focused_pane?.pane_id
  return typeof focused === 'string' && focused === paneId
}

/**
 * Whether this pane already reported this status inside the cooldown. Keyed by
 * status as well as pane: a `done` must never mute the `blocked` that arrives
 * seconds later asking for input.
 */
export function recentlyNotified({ paneState, status, cooldownSeconds, now }) {
  const last = paneState?.[status]
  return typeof last === 'number' && now - last < cooldownSeconds * 1000
}

/** The pane's state after any status change: what it was, and when we saw it. */
export function markSeen({ paneState, status, now }) {
  return { ...(paneState ?? {}), lastStatus: status, lastSeenAt: now }
}

/** The pane's state after a message, keeping every other status' timestamp. */
export function markNotified({ paneState, status, now }) {
  const next = { ...(paneState ?? {}) }
  // Releases before 0.2 kept a single `lastNotifiedAt` per pane; drop it.
  delete next.lastNotifiedAt
  next[status] = now
  return next
}

/** The message body: headline, where to look, and what the pane is showing. */
export function formatMessage({
  status,
  pane,
  context,
  paneId,
  home = process.env.HOME,
  others = [],
  rosterLimit = DEFAULT_ROSTER_LIMIT,
}) {
  const agent = agentLabel(pane, context)
  const cwd = compactHome(pane?.cwd ?? pane?.foreground_cwd ?? context?.focused_pane_cwd, home)
  const title = terminalTitle(pane, cwd)

  return [
    `${headlineFor(status)(agent)}${waitingSuffix(others)}`,
    herdrReference({ pane, context, paneId }),
    [title, cwd].filter(Boolean).join(' · '),
    ...rosterLines(others, { limit: rosterLimit }),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The other agents in the session, most urgent first: panes Herdr reports as
 * running an agent, minus the one this message is already about.
 */
export function rosterFromSnapshot(snapshot, { excludePaneId } = {}) {
  const tabs = new Map((snapshot?.tabs ?? []).map((tab) => [tab.tab_id, tab]))

  return (snapshot?.panes ?? [])
    .filter((pane) => isAgentPane(pane) && pane.pane_id !== excludePaneId)
    .map((pane) => {
      const tab = tabs.get(pane.tab_id)
      return {
        agent: String(pane.agent).trim().toLowerCase(),
        status: String(pane.agent_status ?? '')
          .trim()
          .toLowerCase(),
        project: projectName(pane.cwd ?? pane.foreground_cwd),
        tabLabel: tab?.label,
        tabNumber: tab?.number ?? 0,
        paneId: pane.pane_id,
        // A tab id only earns its space when the tab holds more than one pane.
        sharedTab: (tab?.pane_count ?? 1) > 1,
      }
    })
    .sort((a, b) => rosterRank(a.status) - rosterRank(b.status) || a.tabNumber - b.tabNumber)
}

/** The roster block, or nothing when it is switched off or empty. */
export function rosterLines(entries, { limit = DEFAULT_ROSTER_LIMIT } = {}) {
  if (limit <= 0 || entries.length === 0) return []

  const shown = entries.slice(0, limit)
  const hidden = entries.length - shown.length
  const header = `── other ${plural(entries.length, 'agent')} · ${entries.length} ──`

  // Never truncate silently: the remainder is named, not dropped.
  return [header, ...shown.map(rosterLine), ...(hidden > 0 ? [`+${hidden} more`] : [])]
}

/**
 * Front-load the reason to pick up the phone: a blocked agent is the one thing
 * that cannot wait for you to open the message.
 */
function waitingSuffix(others) {
  const waiting = others.filter((entry) => entry.status === 'blocked').length
  return waiting > 0 ? ` · ${waiting} waiting` : ''
}

function rosterLine({ agent, status, project, tabLabel, paneId, sharedTab }) {
  const icon = ROSTER[status]?.icon ?? ROSTER_FALLBACK.icon
  const where = [
    project,
    tabLabel === undefined ? undefined : `tab ${tabLabel}`,
    sharedTab ? paneId : undefined,
  ].filter(Boolean)

  return [`${icon} ${agent}`, ...where].join(' · ')
}

function rosterRank(status) {
  return ROSTER[status]?.rank ?? ROSTER_FALLBACK.rank
}

function isAgentPane(pane) {
  return typeof pane?.agent === 'string' && pane.agent.trim() !== ''
}

/** Last path segment: what the pane is working on, in one word. */
function projectName(path) {
  return String(path ?? '')
    .trim()
    .split('/')
    .filter(Boolean)
    .at(-1)
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`
}

/** A state we have no wording for is still worth a sentence, never a placeholder. */
function headlineFor(status) {
  return HEADLINE[status] ?? ((agent) => `🔔 ${agent} is ${status}`)
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

function compactHome(path, home) {
  const text = String(path ?? '').trim()
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
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT - 1)}…`
}
