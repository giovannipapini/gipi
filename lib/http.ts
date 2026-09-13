/**
 * Shared HTTP client for pi extensions.
 *
 * Supports:
 *   - GET / POST with JSON body
 *   - Per-call auth headers (Bearer token, x-api-key, etc.)
 *   - Timeout via AbortSignal (with fallback for older runtimes)
 *   - Defensive JSON parsing with clear error messages for non-JSON bodies
 *   - Retry-free by design — each call has one shot; wrap in a retry loop
 *     from the caller if needed.
 *
 * Usage:
 *   import { jsonPost, jsonGet } from '../../lib/http.js'
 *
 *   const data = await jsonPost('https://api.example.com/v1/search',
 *     { headers: { Authorization: `Bearer ${key}` } },
 *     { query: 'foo' },
 *     signal,
 *   )
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface HttpOptions {
  headers?: Record<string, string>
  /** Base URL prepended to path (no trailing slash). */
  baseUrl?: string
}

export interface HttpResult {
  /** Parsed JSON body. */
  data: Record<string, unknown>
  /** HTTP status code. */
  status: number
}

// ── Internals ──────────────────────────────────────────────────────────────

function shortUrl(u: string): string {
  try {
    const { host, pathname } = new URL(u)
    return host + pathname
  } catch {
    return u
  }
}

function resolveUrl(pathOrUrl: string, baseUrl?: string): string {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl
  if (baseUrl) return `${baseUrl.replace(/\/+$/, '')}/${pathOrUrl.replace(/^\/+/, '')}`
  return pathOrUrl
}

function combineSignals(outer?: AbortSignal, timeoutMs?: number): AbortSignal {
  const signals: AbortSignal[] = []
  if (outer) signals.push(outer)
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signals.length === 0) return new AbortController().signal
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  return signals[0] // fallback for older Node
}

const DEFAULT_TIMEOUT_MS = 60_000

async function request(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResult> {
  const combined = combineSignals(signal, timeoutMs)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: combined })
  } catch (e) {
    const aborted = signal?.aborted || (e instanceof Error && e.name === 'AbortError')
    throw new Error(
      aborted
        ? `Request to ${shortUrl(url)} was cancelled or timed out.`
        : `Request to ${shortUrl(url)} failed: ${errMsg(e)}`,
    )
  }

  const body = await res.text().catch(() => '')
  let json: unknown
  if (body) {
    try {
      json = JSON.parse(body)
    } catch {
      /* non-JSON — handled below */
    }
  }

  if (!res.ok) {
    const o = ensureObject(json)
    const detail =
      asStr(o.error || o.message || o.detail) || body.slice(0, 400) || res.statusText || 'no body'
    throw new Error(`${shortUrl(url)} → HTTP ${res.status}: ${detail}`)
  }

  if (json === undefined) {
    throw new Error(
      `${shortUrl(url)} returned a non-JSON response (HTTP ${res.status}): ${
        body.slice(0, 200) || 'empty body'
      }`,
    )
  }

  return { data: ensureObject(json), status: res.status }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** JSON POST request. Returns parsed JSON body. */
export function jsonPost(
  url: string,
  opts: HttpOptions,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<HttpResult> {
  const resolved = resolveUrl(url, opts.baseUrl)
  return request(
    resolved,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
    },
    signal,
    timeoutMs,
  )
}

/** JSON GET request. Returns parsed JSON body. */
export function jsonGet(
  url: string,
  opts: HttpOptions,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<HttpResult> {
  const resolved = resolveUrl(url, opts.baseUrl)
  return request(
    resolved,
    {
      method: 'GET',
      headers: { Accept: 'application/json', ...opts.headers },
    },
    signal,
    timeoutMs,
  )
}

/** Poll a GET endpoint until a completion condition is met. */
export async function pollGet<T>(
  url: string,
  opts: HttpOptions,
  signal: AbortSignal | undefined,
  options: {
    isDone: (data: Record<string, unknown>) => boolean
    isFailed?: (data: Record<string, unknown>) => boolean
    /** Max total wait in ms (default 180s). */
    maxWaitMs?: number
    /** Initial poll interval in ms (default 3s). */
    pollIntervalMs?: number
    /** Backoff factor per poll (default 1.5). */
    backoffFactor?: number
    onProgress?: (msg: string) => void
  },
): Promise<T> {
  const maxWait = options.maxWaitMs ?? 180_000
  let pollMs = options.pollIntervalMs ?? 3_000
  const backoff = options.backoffFactor ?? 1.5
  const deadline = Date.now() + maxWait

  while (true) {
    const { data } = await jsonGet(url, opts, signal, maxWait)
    if (options.isFailed?.(data)) {
      throw new Error(`Polling ${shortUrl(url)} failed: ${asStr(data.error) || 'unknown error'}`)
    }
    if (options.isDone(data)) return data as unknown as T
    if (Date.now() > deadline) {
      options.onProgress?.(`Polling ${shortUrl(url)} timed out — returning partial results.`)
      return data as unknown as T
    }
    await sleep(pollMs, signal)
    pollMs = Math.min(pollMs * backoff, 10_000)
  }
}

// ── Tiny helpers (self-contained, no Zod dependency) ───────────────────────

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const ensureObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}
