/**
 * Shared API key validation helpers.
 *
 * Each key type has a prefix regex for format validation. Usage:
 *
 *   const key = requireEnvKey('EXA_API_KEY', /^[a-f0-9-]{36}$/,
 *     'https://exa.ai/dashboard')
 *
 *   const key = requireEnvKey('CONTEXT7_API_KEY', /^ctx7sk-/,
 *     'https://context7.com/dashboard')
 *
 * On missing or malformed keys, the helpers throw with a clear
 * message including where to obtain a valid key.
 */

// ── Validation regexes ────────────────────────────────────────────────────

export const KEY_PATTERNS = {
  EXA_API_KEY: { pattern: /^.{16,}$/, hint: 'expected at least 16 characters' },
  FIRECRAWL_API_KEY: { pattern: /^fc-/, hint: "expected a key starting with 'fc-'" },
  CONTEXT7_API_KEY: { pattern: /^ctx7sk-/, hint: "expected a key starting with 'ctx7sk-'" },
} as const

type KeyName = keyof typeof KEY_PATTERNS

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read a key from process.env, validate its format, return it or throw. */
export function requireEnvKey(name: KeyName, helpUrl?: string): string {
  const key = process.env[name]?.trim()
  if (!key) {
    const url = helpUrl ?? `https://${name.toLowerCase().replace(/_/g, '.')}/dashboard`
    throw new Error(`${name} is not set. Get one at ${url} and export it in your environment.`)
  }
  return validateKey(name, key, helpUrl)
}

/** Validate a key's format — no-op if valid, throws if not. */
export function validateKey(name: KeyName, key: string, helpUrl?: string): string {
  const keyConfig = KEY_PATTERNS[name]
  if (!keyConfig.pattern.test(key)) {
    const url = helpUrl ?? `https://${name.toLowerCase().replace(/_/g, '.')}/dashboard`
    throw new Error(`${name} format looks wrong — ${keyConfig.hint}. Check your key at ${url}`)
  }
  return key
}

/** Check if a key looks present and valid (no throw, returns boolean). */
export function isKeyValid(name: KeyName, key?: string): boolean {
  if (!key) return false
  const keyConfig = KEY_PATTERNS[name]
  return keyConfig.pattern.test(key)
}

/** Read a key from process.env and return it if valid, or undefined. */
export function optionalKey(name: KeyName): string | undefined {
  const key = process.env[name]?.trim()
  if (!key) return undefined
  return isKeyValid(name, key) ? key : undefined
}
