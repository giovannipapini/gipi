/**
 * notify-stuck.ts — Desktop notification via kitty/ghostty OSC 99 protocol
 *
 * Sends a one-shot desktop notification when gipi-safety blocks the agent
 * and the terminal window is not the frontmost application (unfocused).
 *
 * Protocol: kitty OSC 99 (supported by both kitty and ghostty)
 *   https://sw.kovidgoyal.net/kitty/desktop-notifications/
 *
 * Focus detection: macOS osascript — checks if the terminal emulator process
 * is the frontmost application. Only fires when unfocused.
 */

import { execSync } from 'node:child_process'
import process from 'node:process'

// ── State ────────────────────────────────────────────────────────────

/** Whether a notification has been sent for the current stuck event */
let stuckNotified = false

// ── Terminal detection ───────────────────────────────────────────────

/**
 * Terminal program names that support the kitty OSC 99 notification protocol.
 * Ghostty is the primary target; kitty is compatible.
 */
const SUPPORTED_TERMINALS = new Set(['ghostty', 'kitty'])

export function isSupportedTerminal(): boolean {
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  return SUPPORTED_TERMINALS.has(term)
}

/**
 * The macOS application name for osascript frontmost detection.
 * Returns null for unsupported terminals or non-macOS platforms.
 */
function terminalAppName(): string | null {
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  // Ghostty process name is "Ghostty", kitty process name is "kitty"
  if (term === 'ghostty') return 'Ghostty'
  if (term === 'kitty') return 'kitty'
  return null
}

// ── Focus detection ──────────────────────────────────────────────────

/**
 * Check if the terminal window is the frontmost (focused) application.
 * Uses osascript on macOS. Falls back to "focused" (true) on failure
 * or non-macOS platforms — meaning no notification is sent.
 */
export function isTerminalFocused(): boolean {
  const appName = terminalAppName()
  if (!appName) return true // can't detect, assume focused → no notification

  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to get frontmost of first process whose name is "${appName}"'`,
      { timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
    )
    return result.trim() === 'true'
  } catch {
    return true // error (e.g. process not running), assume focused
  }
}

// ── OSC 99 notification ──────────────────────────────────────────────

/**
 * Send a desktop notification via the kitty OSC 99 protocol.
 *
 * Uses a two-part chunked notification:
 *   1. Title (with d=0 — signal "more parts coming")
 *   2. Body  (no d — implicitly complete)
 *
 * Both parts share the same notification ID (`gipi-safety`) so the
 * terminal assembles them into one notification. If a new notification
 * arrives while the old one is still visible, it replaces the old one.
 *
 * Escapes control characters that could corrupt the OSC sequence.
 */
function stripControlChars(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f || c === 0x3b) out += ' '
    else out += s[i]
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function sendOSC99Notification(title: string, body: string): void {
  const safeTitle = stripControlChars(title)
  const safeBody = stripControlChars(body)
  if (!safeBody) return

  const notifId = 'gipi-safety'

  try {
    // Part 1: title (not yet complete — d=0 defers display)
    if (safeTitle) {
      process.stdout.write(`\x1b]99;i=${notifId}:d=0;${safeTitle}\x1b\\`)
    }
    // Part 2: body (no d → displayed immediately, assembling with title)
    process.stdout.write(`\x1b]99;i=${notifId}:p=body;${safeBody}\x1b\\`)
  } catch {
    // Best-effort: silently ignore write errors
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to send a stuck-agent notification.
 *
 * Guards:
 *  - Only fires when the terminal supports OSC 99 (ghostty/kitty)
 *  - Only fires when the terminal window is NOT the frontmost app
 *  - Only fires ONCE per stuck event (idempotent until reset)
 *
 * Call this right before showing the blocking confirmation prompt.
 */
export function notifyStuck(): void {
  if (stuckNotified) return
  if (!isSupportedTerminal()) return
  if (isTerminalFocused()) return

  sendOSC99Notification('🤖 gipi-safety', 'Agent waiting for your response')
  stuckNotified = true
}

/**
 * Call when the stuck event ends (after the user responds to the prompt)
 * to allow a new notification on the next stuck event.
 */
export function resetStuckNotified(): void {
  stuckNotified = false
}
