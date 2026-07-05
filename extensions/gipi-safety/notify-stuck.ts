/**
 * notify-stuck.ts — Desktop notification when agent is stuck
 *
 * Sends a one-shot desktop notification when gipi-safety blocks the agent
 * and the terminal window is not the frontmost application, so the user
 * is alerted to check the terminal.
 *
 * Uses the OSC 99 (Kitty desktop notification protocol) escape-code
 * sequence when running in a compatible terminal (kitty, ghostty,
 * wezterm, foot…). No external binaries needed — the terminal handles
 * focus gating via `o=unfocused`, and notifications work on any OS the
 * terminal supports (macOS, Linux, Windows).
 *
 * If the terminal does not support OSC 99, no notification is sent.
 */

import process from 'node:process'

// ── State ────────────────────────────────────────────────────────────

/** Whether a notification has been sent for the current stuck event */
let stuckNotified = false

// ── OSC 99 (Kitty desktop notification protocol) ────────────────────

/**
 * Terminals known to support the OSC 99 desktop notification protocol.
 *
 * OSC 99 is the Kitty desktop notification protocol, also implemented by
 * Ghostty, WezTerm, Foot, and others:
 *   https://sw.kovidgoyal.net/kitty/desktop-notifications/
 */
const OSC_99_TERMINALS = new Set(['kitty', 'ghostty', 'wezterm', 'foot'])

/** True if the current terminal is known to support OSC 99. */
function canUseOSC99(): boolean {
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  return OSC_99_TERMINALS.has(term)
}

/**
 * Send a desktop notification via the OSC 99 (Kitty) escape-code protocol.
 *
 * Format:  <ESC>]99;metadata;payload<ESC>\
 *
 * Keys used:
 *   i=<id>         — notification identifier (allows replacing on re-sends)
 *   o=unfocused    — only display when the terminal window does NOT have
 *                    keyboard focus (the terminal handles gating)
 *   u=2            — critical urgency
 *   p=title/body   — payload type
 *   d=0/1          — chunking: 0 = not done (hold), 1 = done (display)
 *
 * The title is sent with d=0 to hold it until the body arrives with d=1.
 */
function sendOSC99Notification(title: string, subtitle: string, body: string): void {
  const OSC = '\x1b]'
  const ST = '\x1b\\'
  const id = 'gipi-stuck'

  // Title chunk (d=0: hold — don't display yet)
  process.stdout.write(`${OSC}99;i=${id}:o=unfocused:u=2:d=0:p=title;${title}${ST}`)
  // Body chunk (d=1: done, display now)
  process.stdout.write(`${OSC}99;i=${id}:d=1:p=body;${subtitle}: ${body}${ST}`)
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to send a stuck-agent notification.
 *
 * Guards:
 *  - Only fires ONCE per stuck event (idempotent until reset)
 *  - Only fires when in an OSC 99-compatible terminal (kitty, ghostty,
 *    wezterm, foot…). The terminal handles focus gating via
 *    `o=unfocused` — no process check needed.
 *  - Silently no-ops in any other terminal.
 *
 * Call this right before showing the blocking confirmation prompt.
 */
export function notifyStuck(): void {
  if (stuckNotified) return
  if (!canUseOSC99()) return

  sendOSC99Notification('pi', 'gipi-safety', 'Agent waiting for your response')
  stuckNotified = true
}

/**
 * Call when the stuck event ends (after the user responds to the prompt)
 * to allow a new notification on the next stuck event.
 */
export function resetStuckNotified(): void {
  stuckNotified = false
}
