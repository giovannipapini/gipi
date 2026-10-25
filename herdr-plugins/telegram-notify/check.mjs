/**
 * `check` action: print resolved configuration without printing the token.
 */

import { statSync } from 'node:fs'
import { envFilePaths, envFlag, envNumber, loadDotEnv, stateDir } from './lib.mjs'

loadDotEnv()

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = process.env.TELEGRAM_CHAT_ID?.trim()

console.log(`plugin      ${process.env.HERDR_PLUGIN_ID ?? '(not run by Herdr)'}`)
console.log(`config dir  ${process.env.HERDR_PLUGIN_CONFIG_DIR ?? '(unset)'}`)
console.log(`state dir   ${stateDir()}`)
console.log(`states      ${process.env.TELEGRAM_STATES ?? 'blocked'} (default)`)
console.log(`quiet focus ${envFlag('TELEGRAM_QUIET_WHEN_FOCUSED', true)}`)
console.log(`cooldown    ${envNumber('TELEGRAM_COOLDOWN_SECONDS', 120)}s`)

for (const path of envFilePaths()) {
  let info = 'missing'
  try {
    const stat = statSync(path)
    info = `${(stat.mode & 0o777).toString(8)} ${stat.size}B`
  } catch {
    info = 'missing'
  }
  console.log(`env file    ${path} [${info}]`)
}

console.log(`token       ${token ? `set (${token.length} chars)` : 'MISSING'}`)
console.log(`chat id     ${chatId ? `set (${chatId.length} chars)` : 'MISSING'}`)
