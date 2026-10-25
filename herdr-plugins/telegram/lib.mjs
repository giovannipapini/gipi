/**
 * Infrastructure for the gipi Herdr plugins: environment files, the state file,
 * the Telegram call and Herdr's pane snapshot. Policy lives in `hook.mjs`.
 *
 * Credentials live in `$HERDR_PLUGIN_CONFIG_DIR/.env` (managed by Herdr, outside
 * this repo) or in a development-only `.env` beside this file. Nothing here ever
 * logs a token: `redact()` strips it from every thrown or printed message, since
 * the Telegram endpoint embeds the token in its URL and `fetch` errors quote URLs.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(fileURLToPath(import.meta.url))

const PRIVATE_MODE = 0o600

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function dotEnvPaths() {
  const paths = []
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    paths.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, '.env'))
  }
  paths.push(join(pluginRoot, '.env'))
  return [...new Set(paths)]
}

/** Keep credential files owner-only; fix a too-broad mode instead of trusting it. */
function ensurePrivate(path) {
  try {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      chmodSync(path, PRIVATE_MODE)
      console.error(`chmod 600 ${path} (was ${mode.toString(8)})`)
    }
    return PRIVATE_MODE
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`cannot inspect ${path}: ${error.code}`)
    return undefined
  }
}

export function envFilePaths() {
  return dotEnvPaths()
}

export function loadDotEnv() {
  for (const path of dotEnvPaths()) {
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const equals = line.indexOf('=')
      if (equals === -1) continue
      const key = line.slice(0, equals).trim()
      if (!key || process.env[key] !== undefined) continue
      process.env[key] = stripQuotes(line.slice(equals + 1).trim())
    }

    ensurePrivate(path)
  }
}

export function envFlag(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

export function envNumber(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) ? raw : fallback
}

export function readJsonEnv(name) {
  const raw = process.env[name]
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`invalid ${name}: ${error.message}`)
    return {}
  }
}

export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(base, 'gipi', 'herdr-telegram')
}

export function readState() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function writeState(state) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function redact(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const value = String(text ?? '')
  if (!token) return value
  return value.split(token).join('<token>')
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) throw new Error('missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')

  const url = `https://api.telegram.org/bot${token}/sendMessage`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })
  } catch (error) {
    throw new Error(`telegram request failed: ${redact(error?.message)}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`telegram sendMessage failed: ${response.status} ${redact(body)}`)
  }
}

/** JSON `result` from a Herdr CLI call, or undefined when Herdr cannot answer. */
function herdrJson(args) {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr'
  const result = spawnSync(bin, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout)?.result
  } catch {
    return undefined
  }
}

/** Authoritative pane snapshot, or undefined when the pane is already gone. */
export function paneInfo(paneId) {
  return paneId ? herdrJson(['pane', 'get', paneId])?.pane : undefined
}

/** Live session state — every pane, tab and workspace — or undefined when Herdr is unreachable. */
export function sessionSnapshot() {
  return herdrJson(['api', 'snapshot'])?.snapshot
}
