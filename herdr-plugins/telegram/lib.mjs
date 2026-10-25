/**
 * Infrastructure for the gipi Herdr plugins: environment files, the state file,
 * the Telegram client and Herdr's pane snapshot. Policy lives in `hook.mjs`.
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
import { DEFAULT_MAX_ATTEMPTS, isRetryable, retryDelayMs } from './hook.mjs'

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

const TELEGRAM_API = 'https://api.telegram.org'

/** A failed Telegram call, carrying what a retry decision needs. */
export class TelegramError extends Error {
  constructor(message, { status, retryAfterSeconds, network = false } = {}) {
    super(message)
    this.name = 'TelegramError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.network = network
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function credentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) throw new TelegramError('missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
  return { token, chatId }
}

/** Whether credentials exist, without throwing at a caller that only wants to report. */
export function hasCredentials() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim())
}

/**
 * Optional forum topic to post into, so a busy chat can be split by topic instead
 * of by filtering. Telegram ignores it in a non-forum chat.
 */
export function messageThreadId() {
  const raw = Number(process.env.TELEGRAM_MESSAGE_THREAD_ID)
  return Number.isInteger(raw) && raw > 0 ? raw : undefined
}

/** One HTTP round trip: JSON for most methods, multipart for an upload. */
async function request(method, payload) {
  const { token } = credentials()
  const url = `${TELEGRAM_API}/bot${token}/${method}`
  const body =
    payload instanceof FormData
      ? { body: payload }
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }

  let response
  try {
    response = await fetch(url, { method: 'POST', ...body })
  } catch (error) {
    throw new TelegramError(`telegram ${method} failed: ${redact(error?.message)}`, {
      network: true,
    })
  }

  const text = await response.text().catch(() => '')
  const parsed = parseJson(text)
  if (response.ok && parsed?.ok !== false) return parsed?.result

  const description = parsed?.description ?? text.slice(0, 200)
  throw new TelegramError(`telegram ${method} failed: ${response.status} ${redact(description)}`, {
    status: response.status,
    retryAfterSeconds: parsed?.parameters?.retry_after,
  })
}

/**
 * The same call, retried only where a retry can help: a rate limit, a 5xx, a
 * dropped connection. A rejected token is final — retrying it just hides it.
 */
export async function telegram(method, payload, { attempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(method, payload)
    } catch (error) {
      if (!isRetryable(error) || attempt >= attempts) throw error
      const wait = retryDelayMs({ attempt, retryAfterSeconds: error.retryAfterSeconds })
      console.error(`retry ${method} in ${wait / 1000}s (${error.message})`)
      await sleep(wait)
    }
  }
}

/**
 * Send the message, replying to this pane's previous one when there is one. A
 * reply target that no longer exists costs the reply, never the message.
 */
export async function sendMessage({ text, silent = false, replyTo, threadId } = {}) {
  const { chatId } = credentials()
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    disable_notification: silent,
  }
  if (threadId !== undefined) payload.message_thread_id = threadId
  if (replyTo !== undefined) payload.reply_to_message_id = replyTo

  try {
    const result = await telegram('sendMessage', payload)
    return { messageId: result?.message_id, threadId: result?.message_thread_id, replied: true }
  } catch (error) {
    if (!isDroppedReply(error) || replyTo === undefined) throw error
    delete payload.reply_to_message_id
    const result = await telegram('sendMessage', payload)
    return { messageId: result?.message_id, threadId: result?.message_thread_id, replied: false }
  }
}

/** The thread's earlier message was deleted, or the chat moved on. */
function isDroppedReply(error) {
  return error?.status === 400 && /repl/i.test(error?.message)
}

/** A message too long for `sendMessage`, delivered whole as a text file. */
export async function sendDocument({ text, filename, caption, silent = false, threadId } = {}) {
  const { chatId } = credentials()
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('document', new Blob([text], { type: 'text/plain; charset=utf-8' }), filename)
  form.append('disable_notification', String(silent))
  if (caption) form.append('caption', caption.slice(0, 1024))
  if (threadId !== undefined) form.append('message_thread_id', String(threadId))

  const result = await telegram('sendDocument', form)
  return { messageId: result?.message_id, threadId: result?.message_thread_id }
}

/** Who the token belongs to: the one call that proves the credential still works. */
export function getMe() {
  return telegram('getMe', {})
}

/** Whether the configured chat is reachable, and what kind of chat it is. */
export function getChat(chatId) {
  return telegram('getChat', { chat_id: chatId })
}

/**
 * Best effort: say it at the terminal too. A notifier that fails silently is
 * worse than no notifier, and `herdr notification show` honours the user's own
 * toast settings — including switching it off.
 */
export function toast(title, body) {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr'
  const args = ['notification', 'show', String(title).slice(0, 80), '--sound', 'request']
  if (body) args.push('--body', String(body).slice(0, 200))
  try {
    spawnSync(bin, args, { encoding: 'utf8', timeout: 2_000 })
  } catch {
    // no Herdr on this host: the log still carries the failure
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
