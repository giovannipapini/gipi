/**
 * `check` action: print resolved configuration without printing the token.
 */

import { statSync } from 'node:fs'
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_QUIET_WHEN_FOCUSED,
  DEFAULT_ROSTER_LIMIT,
  DEFAULT_STATES,
} from './hook.mjs'
import { envFilePaths, envFlag, envNumber, loadDotEnv, stateDir } from './lib.mjs'

loadDotEnv()

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = process.env.TELEGRAM_CHAT_ID?.trim()

const states = process.env.TELEGRAM_STATES?.trim()

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

for (const path of envFilePaths()) {
  console.log(`env file    ${path} [${describeFile(path)}]`)
}

console.log(`token       ${token ? `set (${token.length} chars)` : 'MISSING'}`)
console.log(`chat id     ${chatId ? `set (${chatId.length} chars)` : 'MISSING'}`)

/** `mode size` for a credential file that loaded, else why it did not. */
function describeFile(path) {
  try {
    const stat = statSync(path)
    return `${(stat.mode & 0o777).toString(8)} ${stat.size}B`
  } catch {
    return 'missing'
  }
}
