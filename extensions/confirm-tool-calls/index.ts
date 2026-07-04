import { resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'
import type { Plugin } from './plugin.js'
import { safeRulesPlugin } from './plugin-safe-rules.js'
import { substitutionPlugin } from './plugin-substitutions.js'
import {
  isDangerousCommand,
  isInGitRepo,
  isSafeBashSegment,
  isSafePath,
  isUnderDotGit,
  splitPipeline,
} from './safety.js'
import { confirmBackgroundKill, confirmBash, confirmFileOp, type Decision } from './ui.js'

const BLOCKED_REASON = 'Blocked by user'

// Plugin pipeline — sorted by priority desc; highest priority runs first.
// To add a new steering feature: create a plugin file, give it a priority, and add it here.
// To add read-only auto-approvals: add phrases to plugin-safe-rules.ts (no wiring needed).
const PLUGINS: Plugin[] = [
  safeRulesPlugin, // priority  5 — declarative read-only auto-approvals
  substitutionPlugin, // priority  0 — modern bash tools (rg, fd, jaq, pnpm) > legacy
].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

// Auto-approve a command iff every pipeline segment is independently safe — either via core
// safety rules or any plugin's isSafeShellSegment. A `rg foo | head` mixes both sources fine.
// Segments are passed untrimmed; isSafeBashSegment and isSafeShellSegment trim each themselves.
function isPipelineSafe(command: string): boolean {
  const segments = splitPipeline(command)
  if (segments === null) return false
  return segments.every(
    (seg) => isSafeBashSegment(seg) || PLUGINS.some((p) => p.isSafeShellSegment?.(seg)),
  )
}

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

type Inp = Record<string, unknown>

interface Stats {
  auto: number
  confirmed: number
  blocked: number
}

type GuardResult = { block: true; reason: string } | { steer: string } | undefined

// To add a new shell tool: add one entry below. The handler is generic over these configs.
interface ShellConfig {
  allowed: Set<string>
  keyOf(cmd: string, inp: Inp): string
  cwdOf?(inp: Inp): string | undefined
  envOf?(inp: Inp): Record<string, string> | undefined
}

// To add a new file tool: add one entry below.
interface FileConfig {
  actionOf(inp: Inp): 'Write' | 'Edit' | 'Create'
}

function inputRecord(input: unknown): Inp {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Inp) : {}
}

function stringInput(inp: Inp, key: string): string | undefined {
  const value = inp[key]
  return typeof value === 'string' ? value : undefined
}

function stringEnv(inp: Inp): Record<string, string> | undefined {
  const raw = inp.env
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') env[key] = value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function resolveToolPath(ctx: ExtensionContext, path: string): string {
  return resolve(ctx.cwd, path)
}

export default function (pi: ExtensionAPI) {
  let enabled = true
  let repoWriteLock = true
  const allowedCommands = new Set<string>()
  const allowedPaths = new Set<string>()
  const stats: Stats = { auto: 0, confirmed: 0, blocked: 0 }
  const pluginSessions = new Map(PLUGINS.map((p) => [p.name, new Map<string, string>()]))

  const SHELL_TOOLS = new Map<string, ShellConfig>([
    [
      'bash',
      {
        allowed: allowedCommands,
        keyOf: (cmd) => cmd,
        cwdOf: (inp) => stringInput(inp, 'cwd'),
        envOf: stringEnv,
      },
    ],
    [
      'bash_async',
      {
        allowed: allowedCommands,
        keyOf: (cmd) => cmd,
        cwdOf: (inp) => stringInput(inp, 'cwd'),
        envOf: stringEnv,
      },
    ],
  ])

  const FILE_TOOLS = new Map<string, FileConfig>([
    ['write', { actionOf: () => 'Write' }],
    ['edit', { actionOf: () => 'Edit' }],
  ])

  // File tools that run through the plugin pipeline before the confirm guard.
  const FILE_PIPELINE_TOOLS = new Set(['read', 'edit'])

  function statusLabel(): string {
    const { auto, confirmed, blocked } = stats
    const counts =
      auto + confirmed + blocked === 0 ? 'confirm ✓' : `auto:${auto} ok:${confirmed} no:${blocked}`
    const wTag = repoWriteLock ? '' : ` ${YELLOW}w:free`
    return `${GREEN}🔒 ${counts}${wTag}${RESET} ·`
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      'confirm-tools',
      enabled ? statusLabel() : `${YELLOW}🤖 auto-approve ✓${RESET} ·`,
    )
  }

  async function applyGuard(
    ctx: ExtensionContext,
    safe: boolean,
    allowed: Set<string>,
    key: string,
    prompt: () => Promise<Decision>,
    bypassCache = false,
  ): Promise<GuardResult> {
    if (safe || (!bypassCache && allowed.has(key))) {
      stats.auto++
      updateStatus(ctx)
      return
    }
    const decision = await prompt()
    if (decision === 'no') {
      stats.blocked++
      updateStatus(ctx)
      return { block: true, reason: BLOCKED_REASON }
    }
    if (typeof decision === 'object' && decision.kind === 'no-steer') {
      stats.blocked++
      updateStatus(ctx)
      return { block: true, reason: decision.reason }
    }
    if (typeof decision === 'object' && decision.kind === 'yes-steer') {
      stats.confirmed++
      updateStatus(ctx)
      return { steer: decision.message }
    }
    if (decision === 'yes-always' && !bypassCache) allowed.add(key)
    stats.confirmed++
    updateStatus(ctx)
  }

  function toggle(ctx: ExtensionContext) {
    enabled = !enabled
    if (enabled) ctx.ui.notify('Tool confirmation enabled', 'info')
    updateStatus(ctx)
  }

  function toggleRepoWriteLock(ctx: ExtensionContext) {
    repoWriteLock = !repoWriteLock
    ctx.ui.notify(
      repoWriteLock
        ? 'Repo write lock enabled — git-tracked files require confirmation'
        : 'Repo write lock disabled — git-tracked files auto-approve',
      'info',
    )
    updateStatus(ctx)
  }

  pi.registerCommand('confirm', {
    description: 'Toggle tool confirmation (bash/write/edit require approval)',
    handler: async (_args, ctx) => toggle(ctx),
  })

  pi.registerCommand('confirm-writes', {
    description: 'Toggle write/edit confirmation for git-tracked files (outside .git/)',
    handler: async (_args, ctx) => toggleRepoWriteLock(ctx),
  })

  pi.registerShortcut(Key.ctrlShift('e'), {
    description: 'Toggle tool confirmation',
    handler: async (ctx) => toggle(ctx),
  })

  pi.registerShortcut(Key.ctrlShift('w'), {
    description: 'Toggle repo write lock (/confirm-writes)',
    handler: async (ctx) => toggleRepoWriteLock(ctx),
  })

  pi.on('before_agent_start', async (event) => {
    // Accumulate claimed commands in priority order so lower-priority plugins can filter
    // their prompt contributions and avoid injecting contradictory rules.
    const claimed = new Set<string>()
    const additions = PLUGINS.map((p) => {
      const section = p.promptSection?.(event.systemPrompt, claimed) ?? ''
      if (section && p.claims) {
        for (const c of p.claims) claimed.add(c)
      }
      return section
    })
      .filter(Boolean)
      .join('')
    return { systemPrompt: event.systemPrompt + additions }
  })

  pi.on('session_start', async (_event, ctx) => {
    updateStatus(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus('confirm-tools', undefined)
  })

  pi.on('tool_call', async (event, ctx) => {
    // Skip project-level decisions when the project is not trusted
    if (!ctx.isProjectTrusted()) return

    const inp = inputRecord(event.input)
    const shellCfg = SHELL_TOOLS.get(event.toolName)
    const fileCfg = FILE_TOOLS.get(event.toolName)

    // Use typed access for bash_async_manage action check
    const manageKill =
      isToolCallEventType('bash_async_manage', event) && event.input.action === 'kill'

    // plugin pipeline for file tools
    let filePipelineHandled = false
    if (FILE_PIPELINE_TOOLS.has(event.toolName)) {
      // Use typed access for path from edit tool
      const rawPath = isToolCallEventType('edit', event)
        ? event.input.path
        : stringInput(inp, 'path')
      if (!rawPath) return
      const path = resolveToolPath(ctx, rawPath)
      for (const plugin of PLUGINS) {
        const result = await plugin.guardFile?.(event.toolName, path, ctx)
        if (result === undefined) continue
        if ('allow' in result) {
          filePipelineHandled = true
          break
        } // user allowed — skip confirm guard
        if (result.steer) pi.sendUserMessage(result.steer, { deliverAs: 'steer' })
        return { block: true, reason: result.reason }
      }
    }

    // plugin pipeline for shell tools (bash commands → preferred equivalents)
    if (shellCfg) {
      // Use typed access for command from bash/bash_async tools
      const command =
        isToolCallEventType('bash', event) || isToolCallEventType('bash_async', event)
          ? event.input.command
          : stringInput(inp, 'command')
      if (!command) return
      for (const plugin of PLUGINS) {
        const session = pluginSessions.get(plugin.name) ?? new Map<string, string>()
        const result = await plugin.guardShell?.(event.toolName, command, ctx, session)
        if (result === undefined) continue // no opinion — try next plugin
        if ('allow' in result) break // handled + allowed — stop chain
        if (result.steer) pi.sendUserMessage(result.steer, { deliverAs: 'steer' })
        return { block: true, reason: result.reason }
      }
    }

    // confirm guard — skip if the file pipeline already showed UI and the user allowed
    if (filePipelineHandled) return

    const command = stringInput(inp, 'command') ?? ''
    const forcedConfirm = !!shellCfg && isDangerousCommand(command)
    if (!enabled && !forcedConfirm && !manageKill) return
    if (!ctx.hasUI)
      return { block: true, reason: 'Tool confirmation active: no UI available for approval' }

    let result: GuardResult

    if (shellCfg) {
      const cwd = shellCfg.cwdOf?.(inp) ?? ctx.cwd
      const env = shellCfg.envOf?.(inp)
      const hasEnv = !!env && Object.keys(env).length > 0
      // Bind the cache key to env/cwd so a previously-approved command isn't replayed
      // under a different env or working directory (both can change command behavior).
      const baseKey = shellCfg.keyOf(command, inp)
      const key = `${baseKey}\0cwd=${cwd}\0env=${hasEnv ? JSON.stringify(env) : ''}`
      result = await applyGuard(
        ctx,
        !forcedConfirm && !hasEnv && isPipelineSafe(command),
        shellCfg.allowed,
        key,
        () => confirmBash(ctx, command, { cwd, env }),
        forcedConfirm,
      )
    } else if (fileCfg) {
      const rawPath = stringInput(inp, 'path')
      if (!rawPath) return
      const path = resolveToolPath(ctx, rawPath)
      const action = fileCfg.actionOf(inp)
      const inTrackedRepo = !repoWriteLock && !isUnderDotGit(path) && isInGitRepo(path)
      result = await applyGuard(
        ctx,
        isSafePath(path) || inTrackedRepo || PLUGINS.some((p) => p.isSafePath?.(path)),
        allowedPaths,
        `${ctx.cwd}\0${action}\0${path}`,
        () => confirmFileOp(ctx, action, path),
      )
    } else if (manageKill) {
      const id = stringInput(inp, 'id')
      result = await applyGuard(
        ctx,
        false,
        allowedCommands,
        `bash_async_manage\0kill\0${id ?? ''}`,
        () => confirmBackgroundKill(ctx, id),
        true,
      )
    }

    if (!result) return
    if ('steer' in result) {
      pi.sendUserMessage(result.steer, { deliverAs: 'steer' })
      return
    }
    return result
  })
}
