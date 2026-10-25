/**
 * Herdr startup hook: prove the token and the chat still work, so a broken
 * notifier is discovered at boot instead of at the next blocked agent.
 *
 * The session notice is opt-in (`TELEGRAM_STARTUP_NOTICE=1`): startup hooks also
 * run when a new server takes over during a live handoff, and an upgrade should
 * not arrive on the phone looking like an incident.
 */

import { DEFAULT_ROSTER_LIMIT, formatSnapshot } from './hook.mjs'
import {
  envFlag,
  envNumber,
  getChat,
  getMe,
  hasCredentials,
  loadDotEnv,
  sendMessage,
  sessionSnapshot,
  toast,
} from './lib.mjs'

loadDotEnv()

if (!hasCredentials()) {
  // A plugin can be linked before it is configured; `check` is where that shows.
  console.error('skip: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
  process.exit(0)
}

try {
  const me = await getMe()
  const chat = await getChat(process.env.TELEGRAM_CHAT_ID.trim())
  console.log(`ok: @${me.username} → ${chat.type} ${chat.id}`)

  if (envFlag('TELEGRAM_STARTUP_NOTICE', false)) {
    const snapshot = sessionSnapshot()
    const summary = snapshot
      ? formatSnapshot(snapshot, {
          limit: envNumber('TELEGRAM_ROSTER_LIMIT', DEFAULT_ROSTER_LIMIT),
        })
      : 'no session snapshot'
    const sent = await sendMessage({ text: `🚀 herdr is up\n${summary}`, silent: true })
    console.log(`notice sent (message ${sent.messageId ?? 'unknown'})`)
  }
} catch (error) {
  console.error(error.message)
  toast('Telegram plugin is broken', error.message)
  process.exitCode = 1
}
