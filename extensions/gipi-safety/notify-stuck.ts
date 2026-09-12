/**
 * notify-stuck.ts — Desktop notification when agent is stuck
 *
 * Sends a one-shot desktop notification when gipi-safety blocks the agent
 * and the terminal window is not the frontmost application, so the user
 * is alerted to check the terminal.
 *
 * Uses terminal escape-code sequences, selecting the best protocol for
 * the current terminal emulator. No external binaries needed.
 *
 * - OSC 99 (Kitty protocol) — used in Kitty (native). Supports focus
 *   gating, urgency, title/body, icons.
 * - OSC 777 — used in Ghostty, WezTerm, Foot, and others. Supports
 *   title + body.
 * - OSC 9 — universal fallback for any terminal. Body only.
 *
 * The terminal handles focus gating internally — only shows the
 * notification banner when the window is unfocused.
 */

// ── State ────────────────────────────────────────────────────────────

/** Whether a notification has been sent for the current stuck event */
let stuckNotified = false

// ── Protocol detection ───────────────────────────────────────────────

/**
 * Terminal programs that support OSC 99 (Kitty desktop notification
 * protocol) with full features (focus gating, urgency, title/body).
 */
const OSC_99_TERMINALS = new Set(['kitty'])

/** True if the current terminal supports OSC 99 natively. */
function isKittyTerminal(): boolean {
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  return OSC_99_TERMINALS.has(term)
}

// ── Notification senders ─────────────────────────────────────────────

/**
 * Send a desktop notification via the OSC 99 (Kitty) escape-code protocol.
 *
 * Format:  <ESC>]99;metadata;payload<ESC>\
 *
 * Keys:
 *   i=<id>         — notification identifier for updates
 *   o=unfocused    — only display when the window does NOT have focus
 *   u=2            — critical urgency
 *   p=title/body   — payload type
 *   d=0/1          — chunking: 0 = hold, 1 = display
 */
function sendOSC99(title: string, body: string): void {
  const OSC = '\x1b]'
  const ST = '\x1b\\'
  const id = 'gipi-stuck'

  process.stdout.write(`${OSC}99;i=${id}:o=unfocused:u=2:d=0:p=title;${title}${ST}`)
  process.stdout.write(`${OSC}99;i=${id}:d=1:p=body;${body}${ST}`)
}

/**
 * Send a desktop notification via the OSC 777 protocol.
 *
 * Format:  <ESC>]777;notify;title;body<ESC>\ (or BEL as terminator)
 *
 * Supported by Ghostty, WezTerm, Foot, and many others.
 */
function sendOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x1b\\`)
}

/**
 * Send a simple desktop notification via the OSC 9 protocol.
 *
 * Format:  <ESC>]9;message<ESC>\ (or BEL as terminator)
 *
 * Universal fallback, supported by almost every terminal emulator
 * (iTerm2, Ghostty, WezTerm, and others). Body only — no title.
 */
function sendOSC9(body: string): void {
  process.stdout.write(`\x1b]9;${body}\x1b\\`)
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to send a stuck-agent notification.
 *
 * Guards:
 *  - Only fires ONCE per stuck event (idempotent until reset)
 *  - Uses the terminal's native notification protocol:
 *      - OSC 99 in Kitty (focus gating via `o=unfocused`, critical urgency)
 *      - OSC 777 in Ghostty, WezTerm, Foot (title + body)
 *      - OSC 9 in any other terminal (body only)
 *  - Terminals handle focus gating internally.
 *
 * Call this right before showing the blocking confirmation prompt.
 */
export function notifyStuck(): void {
  if (stuckNotified) return

  const title = 'pi agent is stuck'
  const body = 'gipi-safety: agent requires attention!'

  if (isKittyTerminal()) {
    sendOSC99(title, body)
  } else {
    // OSC 777: supported by Ghostty, WezTerm, Foot, and others.
    // OSC 9: universal fallback in case 777 is unknown.
    // Sending both is harmless — the terminal picks the one it knows.
    sendOSC777(title, body)
    sendOSC9(body)
  }

  stuckNotified = true
}

/**
 * Call when the stuck event ends (after the user responds to the prompt)
 * to allow a new notification on the next stuck event.
 */
export function resetStuckNotified(): void {
  stuckNotified = false
}
