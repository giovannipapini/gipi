/**
 * notify-stuck.ts — Desktop notification when agent is stuck
 *
 * Sends a one-shot macOS notification when gipi-safety blocks the agent
 * and the terminal window is not the frontmost application, so the user
 * is alerted to check the terminal.
 *
 * Notification:  node-notifier (native macOS Notification Center via
 *   terminal-notifier binary, which shows the Terminal icon).
 * Focus detection: lsappinfo (fast, no process-launch overhead vs osascript).
 */

import { execSync } from 'node:child_process'
import process from 'node:process'

import notifier from 'node-notifier'

// ── State ────────────────────────────────────────────────────────────

/** Whether a notification has been sent for the current stuck event */
let stuckNotified = false

/**
 * Terminal program → macOS process name lookup for focus detection.
 * Only terminals whose process name we know get focus detection.
 */
const TERMINAL_NAMES = new Map<string, string>([
  ['ghostty', 'Ghostty'],
  ['kitty', 'kitty'],
])
/** The macOS process name of the current terminal, or null if unknown. */
function terminalAppName(): string | null {
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  return TERMINAL_NAMES.get(term) ?? null
}
/**
 * Check if the terminal window is the frontmost (focused) application.
 *
 * Uses `lsappinfo` on macOS which is faster and more reliable than an
 * osascript/System Events round-trip (no process-launch delay).
 *
 * Falls back to `true` (assume focused) on non-macOS or any error —
 * meaning no notification is sent in those cases.
 */
export function isTerminalFocused(): boolean {
  const appName = terminalAppName()
  if (!appName) return true

  try {
    const pid = execSync('lsappinfo front', {
      timeout: 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    if (!pid || !/^\d+$/.test(pid)) return true

    const info = execSync(`lsappinfo info -only name ${pid}`, {
      timeout: 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return info.includes(`"${appName}"`)
  } catch {
    return true
  }
}

/**
 * Send a desktop notification via node-notifier (macOS Notification Center).
 *
 * Uses the bundled terminal-notifier binary, which shows the Terminal icon
 * and supports subtitle, sound, and configurable timeout.
 */
function sendNotification(title: string, subtitle: string, body: string): void {
  notifier.notify(
    {
      title,
      subtitle,
      message: body,
      sound: true,
      timeout: 10,
    },
    (err: Error | null) => {
      if (err) {
        // Best-effort: silently ignore failures
      }
    },
  )
}
/**
 * Attempt to send a stuck-agent notification.
 *
 * Guards:
 *  - Only fires ONCE per stuck event (idempotent until reset)
 *  - Only fires when the terminal window is NOT the frontmost app
 *    (avoids unnecessary notifications while actively working)
 *
 * Call this right before showing the blocking confirmation prompt.
 */
export function notifyStuck(): void {
  if (stuckNotified) return
  if (isTerminalFocused()) return

  sendNotification('pi', 'gipi-safety', 'Agent waiting for your response')
  stuckNotified = true
}

/**
 * Call when the stuck event ends (after the user responds to the prompt)
 * to allow a new notification on the next stuck event.
 */
export function resetStuckNotified(): void {
  stuckNotified = false
}
