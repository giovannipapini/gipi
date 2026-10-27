/**
 * gipi-rtk Extension — RTK command proxying and hook integration
 *
 * Transparently proxies eligible bash/bash_async commands through `rtk` to save
 * 50-90% of output tokens. Uses `rtk rewrite` as the canonical oracle — same
 * decision engine as Cursor/Claude Code shell hooks.
 *
 * Complementary to gipi-safety's substitution plugin:
 *   - substitution plugin  → steer non-preferred tool usage (grep→rg, find→fd, etc.)
 *   - gipi-rtk proxy       → wrap any supported command with rtk output filtering
 *
 * Features:
 *   - Auto-proxy: bash commands matching rtk's rewrite list → `rtk <cmd>`
 *   - Cache: rewrite results cached per session for zero-latency repeat calls
 *   - Analytics commands: `/rtk` (gain), `/rtk-discover` (missed opportunities)
 *   - Toggle: `/rtk-toggle` (alt+r) to disable proxying
 *   - Status bar: shows rtk availability + token savings
 *   - Background refresh: updates rtk gain after each agent turn
 *
 * Placement: gipi/extensions/gipi-rtk/index.ts (discovered via pi package)
 */

import { execFileSync, execSync } from 'node:child_process'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'

/** Commands that must NOT be proxied — interactive, pipeline-breaking, or rtk-irrelevant. */
const NEVER_PROXY = new Set([
  'less',
  'more',
  'vim',
  'nvim',
  'nano',
  'emacs',
  'micro',
  'helix',
  'zed',
  'code',
  'cursor',
  'cd',
  'pushd',
  'popd',
  'source',
  '.',
  'exec',
  'exit',
  'return',
  'set',
  'unset',
  'export',
  'alias',
  'unalias',
  'type',
  'times',
  'trap',
  'bind',
  'eval',
  'declare',
  'local',
  'typeset',
  'readonly',
  'shift',
  'bg',
  'fg',
  'jobs',
  'disown',
  'wait',
  'suspend',
  'rtk', // avoid recursion
])

/** Maximum cache entries for rewrite results. */
const CACHE_MAX = 256

interface RewriteCache {
  rewritten: string | null
  timestamp: number
}

interface Analytics {
  proxied: number
  skipped: number
  sessionStart: number
}

let enabled = true
let rtkAvailable: boolean | null = null // null = unknown, true/false = checked
let rtkVersion = ''

const rewriteCache = new Map<string, RewriteCache>()
const analytics: Analytics = {
  proxied: 0,
  skipped: 0,
  sessionStart: Date.now(),
}

/** Check if rtk is on PATH and get its version. Returns false if unavailable. */
function checkRtkAvailability(): boolean {
  if (rtkAvailable !== null) return rtkAvailable
  try {
    const out = execSync('rtk --version', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    rtkVersion = out.trim()
    rtkAvailable = true
  } catch {
    rtkAvailable = false
  }
  return rtkAvailable
}

/**
 * Query rtk rewrite for a command string.
 * Returns the rewritten command (e.g. "rtk git status") or null if no rewrite.
 * Results are cached per session.
 */
function getRewrite(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  const cached = rewriteCache.get(trimmed)
  if (cached !== undefined) return cached.rewritten

  try {
    // execFileSync, not execSync: the command text is an argv entry, so nothing in
    // it is re-interpreted by a shell. Interpolating it into `rtk rewrite "..."`
    // let backticks and $(...) in the command run during the probe, and heredoc
    // bodies broke out of the quoting and executed locally.
    const out = execFileSync('rtk', ['rewrite', trimmed], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const rewritten = out.trim()
    const cacheEntry: RewriteCache = {
      rewritten: rewritten || null,
      timestamp: Date.now(),
    }
    if (rewriteCache.size >= CACHE_MAX) {
      const oldest = rewriteCache.keys().next().value
      if (oldest !== undefined) rewriteCache.delete(oldest)
    }
    rewriteCache.set(trimmed, cacheEntry)
    return cacheEntry.rewritten
  } catch {
    // rtk exits 1 when no rewrite available — cache as null
    const cacheEntry: RewriteCache = { rewritten: null, timestamp: Date.now() }
    if (rewriteCache.size >= CACHE_MAX) {
      const oldest = rewriteCache.keys().next().value
      if (oldest !== undefined) rewriteCache.delete(oldest)
    }
    rewriteCache.set(trimmed, cacheEntry)
    return null
  }
}

/** Check if the command's first token should never be proxied. */
function shouldSkipProxy(command: string): boolean {
  const firstToken = command.trim().match(/^\S+/)?.[0]
  return firstToken ? NEVER_PROXY.has(firstToken) : true
}

/** Run rtk discover and return the text output. */
function discoverMissedSavings(projectArg?: string): string {
  const discoverArgs = projectArg ? ['discover', '-p', projectArg] : ['discover']
  try {
    const out = execFileSync('rtk', discoverArgs, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024,
    })
    return out.trim()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `rtk discover failed: ${msg}`
  }
}

function updateStatus(ctx: ExtensionContext) {
  if (!rtkAvailable) return
  const statusParts = [`rtk`]
  if (analytics.proxied > 0 || analytics.skipped > 0) {
    statusParts.push(`${analytics.proxied}`)
  }
  statusParts.push('✓')
  ctx.ui.setStatus('gipi-rtk', statusParts.join(' '))
}

/** Apply rtk proxy: given a bash command, return the rewritten command or null. */
function proxyCommand(command: string): string | null {
  if (!enabled || !rtkAvailable) return null
  if (!command?.trim()) return null

  const trimmed = command.trim()

  if (shouldSkipProxy(trimmed)) {
    analytics.skipped++
    return null
  }

  // Multi-line commands are heredocs or inline scripts: rtk has no rule for them,
  // and a newline inside a shell-quoted probe once ran the tail locally as extra
  // commands. The probe no longer uses a shell, but leave these untouched anyway.
  if (/[\r\n]/.test(trimmed)) {
    analytics.skipped++
    return null
  }

  const rewritten = getRewrite(trimmed)
  if (rewritten && rewritten !== trimmed) {
    analytics.proxied++
    return rewritten
  }

  analytics.skipped++
  return null
}

export default function extension(pi: ExtensionAPI) {
  const isRtk = checkRtkAvailability()

  pi.registerCommand('rtk', {
    description: 'Show RTK token savings analytics and status',
    handler: async (_args, ctx) => {
      if (!rtkAvailable) {
        ctx.ui.notify('rtk not found on PATH — install via brew or cargo', 'error')
        return
      }

      ctx.ui.setEditorText('/rtk-analytics')
    },
  })

  pi.registerCommand('rtk-analytics', {
    description: 'Display RTK token savings, efficiency, and proxy stats',
    handler: async (_args, ctx) => {
      if (!rtkAvailable) {
        ctx.ui.notify('rtk not found on PATH', 'error')
        return
      }

      const textOut = execSync('rtk gain 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const sessionElapsed = Math.round((Date.now() - analytics.sessionStart) / 1000)
      const summary = [
        `╭─ rtk proxy status ─────────────────────────`,
        `│`,
        `│  ${enabled ? '🟢  Enabled' : '🔴  Disabled'}   (toggle with /rtk-toggle or alt+r)`,
        `│  Version: ${rtkVersion || '?'}`,
        `│`,
        `│  Commands proxied:  ${analytics.proxied}`,
        `│  Commands skipped:  ${analytics.skipped}`,
        `│  Session uptime:    ${sessionElapsed}s`,
        `│`,
        `╰────────────────────────────────────────────`,
        ``,
        textOut,
      ].join('\n')

      ctx.ui.setEditorText(summary)
    },
  })

  pi.registerCommand('rtk-discover', {
    description: 'Run rtk discover to find missed savings opportunities',
    handler: async (_args, ctx) => {
      if (!rtkAvailable) {
        ctx.ui.notify('rtk not found on PATH', 'error')
        return
      }

      ctx.ui.notify('Scanning for missed savings...', 'info')
      const discoverOutput = discoverMissedSavings()
      ctx.ui.setEditorText(
        `╭─ rtk discover ─────────────────────────────\n│\n${discoverOutput}\n│\n╰────────────────────────────────────────────`,
      )
    },
  })

  pi.registerCommand('rtk-toggle', {
    description: 'Toggle RTK command proxying (proxy commands through rtk for token savings)',
    handler: async (_args, ctx) => {
      if (!rtkAvailable) {
        ctx.ui.notify('rtk not found on PATH — install via brew or cargo', 'error')
        return
      }
      enabled = !enabled
      ctx.ui.notify(
        enabled
          ? 'RTK proxying enabled — eligible commands routed through rtk'
          : 'RTK proxying disabled — commands run raw',
        'info',
      )
      updateStatus(ctx)
    },
  })

  pi.registerShortcut(Key.alt('r'), {
    description: 'Toggle RTK command proxying (/rtk-toggle)',
    handler: async (ctx) => {
      if (!rtkAvailable) return
      enabled = !enabled
      ctx.ui.notify(enabled ? 'rtk proxy on' : 'rtk proxy off', 'info')
      updateStatus(ctx)
    },
  })

  pi.on('before_agent_start', async (event) => {
    if (!isRtk) return
    // Inject rtk instruction into system prompt
    return {
      systemPrompt:
        event.systemPrompt +
        [
          '',
          '## RTK - Rust Token Killer',
          'rtk is installed and automatically proxies eligible bash commands for output token savings.',
          'Run /rtk-analytics to see savings. Toggle with /rtk-toggle.',
          '',
        ].join('\n'),
    }
  })

  pi.on('session_start', async (_event, ctx) => {
    if (!isRtk) {
      ctx.ui.notify(
        'rtk not found on PATH — install via `brew install rtk` or `cargo install rtk`',
        'warning',
      )
      return
    }

    analytics.sessionStart = Date.now()
    updateStatus(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus('gipi-rtk', undefined)
  })

  /** Intercept bash/bash_async/bash_schedule and proxy through rtk. The command
   * is mutated in-place so the LLM never sees the prefix; cache avoids repeated
   * rewrites. For `bash_schedule` the rewrite happens once, at creation — every
   * later run reuses the stored (already proxied) command string. */
  pi.on('tool_call', async (event, _ctx) => {
    if (!enabled || !rtkAvailable) return

    // Extract command from bash or bash_async using the same pattern as gipi-safety
    const command =
      isToolCallEventType('bash', event) ||
      isToolCallEventType('bash_async', event) ||
      isToolCallEventType<'bash_schedule', { command: string }>('bash_schedule', event)
        ? (event.input as { command: string }).command
        : undefined
    if (!command) return

    const rewritten = proxyCommand(command)
    if (!rewritten) return // Mutate the command in-place — pi executes the proxied version
    ;(event.input as { command: string }).command = rewritten
  })
}
