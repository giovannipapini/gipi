/**
 * `check` action: print resolved configuration without printing the token.
 *
 * Offline by default — it reads the same files the hook reads. `--verify` adds
 * the one pair of calls that proves the token and the chat still work.
 */

import { statSync } from 'node:fs'
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_QUIET_WHEN_FOCUSED,
  DEFAULT_ROSTER_LIMIT,
  DEFAULT_SILENT_NONBLOCKED,
  DEFAULT_STATES,
  MAX_MESSAGE_LENGTH,
} from './hook.mjs'
import {
  envFilePaths,
  envFlag,
  envNumber,
  getChat,
  getMe,
  loadDotEnv,
  messageThreadId,
  stateDir,
} from './lib.mjs'

loadDotEnv()

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = process.env.TELEGRAM_CHAT_ID?.trim()

const states = process.env.TELEGRAM_STATES?.trim()
const thread = messageThreadId()

console.log(`plugin      ${process.env.HERDR_PLUGIN_ID ?? '(not run by Herdr)'}`)
console.log(`config dir  ${process.env.HERDR_PLUGIN_CONFIG_DIR ?? '(unset)'}`)
console.log(`state dir   ${stateDir()}`)
console.log(`states      ${states || `${DEFAULT_STATES} (default)`}`)
// pi has no `done`: it reports the end of a turn as working → idle
console.log('turn end    working → idle is read as done')
console.log(`quiet focus ${envFlag('TELEGRAM_QUIET_WHEN_FOCUSED', DEFAULT_QUIET_WHEN_FOCUSED)}`)
console.log(`cooldown    ${envNumber('TELEGRAM_COOLDOWN_SECONDS', DEFAULT_COOLDOWN_SECONDS)}s`)
console.log(
  `roster      ${envNumber('TELEGRAM_ROSTER_LIMIT', DEFAULT_ROSTER_LIMIT)} agents (0 hides it)`,
)
console.log(
  `silent      ${envFlag('TELEGRAM_SILENT_NONBLOCKED', DEFAULT_SILENT_NONBLOCKED) ? 'unless blocked' : 'never'}`,
)
console.log(`reply       chains into the pane's previous message`)
console.log(`topic       ${thread ?? '(none: the chat itself)'}`)
console.log(`long text   document over ${MAX_MESSAGE_LENGTH} chars`)
console.log(
  `startup     ${envFlag('TELEGRAM_STARTUP_NOTICE', false) ? 'verify + session notice' : 'verify only'}`,
)

for (const path of envFilePaths()) {
  console.log(`env file    ${path} [${describeFile(path)}]`)
}

console.log(`token       ${token ? `set (${token.length} chars)` : 'MISSING'}`)
console.log(`chat id     ${chatId ? `set (${chatId.length} chars)` : 'MISSING'}`)

if (process.argv.includes('--verify')) await verify()

/** The only check that leaves the machine. */
async function verify() {
  if (!token || !chatId) {
    console.log('api         skipped: credentials missing')
    process.exitCode = 1
    return
  }
  try {
    const me = await getMe()
    const chat = await getChat(chatId)
    console.log(`api         ok @${me.username} → ${chat.type} ${chat.id}`)
  } catch (error) {
    console.log(`api         FAILED ${error.message}`)
    process.exitCode = 1
  }
}

/** `mode size` for a credential file that loaded, else why it did not. */
function describeFile(path) {
  try {
    const stat = statSync(path)
    return `${(stat.mode & 0o777).toString(8)} ${stat.size}B`
  } catch {
    return 'missing'
  }
}
