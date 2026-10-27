import { resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'
import { notifyStuck, resetStuckNotified } from './notify-stuck.js'
import type { GuardDecision, Plugin } from './plugin.js'
import { safeRulesPlugin } from './plugin-safe-rules.js'
import { substitutionPlugin } from './plugin-substitutions.js'
import { isBlockedPath, isDangerousCommand } from './safety.js'
import { confirmBash, type Decision } from './ui.js'

const BLOCKED_REASON = 'Blocked by user'
const BLOCKED_NO_UI = 'Tool confirmation active: cannot confirm in non-UI mode'

// GIPI_SAFETY=0|false|off|no starts the session with the guard disabled.
const ENV_KEY = 'GIPI_SAFETY'
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no'])

/** Runtime switch for confirmations and plugin guards. Hard blocks ignore it. */
const envDisabled = DISABLED_VALUES.has((process.env[ENV_KEY] ?? '').trim().toLowerCase())
let enabled = !envDisabled

const PLUGINS: Plugin[] = [safeRulesPlugin, substitutionPlugin].sort(
  (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
)

type InputRecord = Record<string, unknown>

interface ShellConfig {
  cwdOf?(toolInput: InputRecord): string | undefined
  envOf?(toolInput: InputRecord): Record<string, string> | undefined
}

interface FileConfig {
  actionOf(toolInput: InputRecord): 'Write' | 'Edit' | 'Create'
}

function inputRecord(input: unknown): InputRecord {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as InputRecord) : {}
}

function stringInput(toolInput: InputRecord, key: string): string | undefined {
  const fieldValue = toolInput[key]
  return typeof fieldValue === 'string' ? fieldValue : undefined
}

function stringEnv(toolInput: InputRecord): Record<string, string> | undefined {
  const raw = toolInput.env
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const [key, fieldValue] of Object.entries(raw)) {
    if (typeof fieldValue === 'string') env[key] = fieldValue
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function resolveToolPath(ctx: ExtensionContext, path: string): string {
  return resolve(ctx.cwd, path)
}

export default function (pi: ExtensionAPI) {
  const pluginSessions = new Map(PLUGINS.map((p) => [p.name, new Map<string, string>()]))

  // Every tool that runs a shell command a human might regret: guarded at the
  // point the model writes it. `bash_schedule` is guarded when the schedule is
  // created — its later runs re-spawn in-process and do not re-enter tool_call,
  // so creation time is the one place a guard can land.
  const SHELL_TOOLS = new Map<string, ShellConfig>([
    ['bash', { cwdOf: (toolInput) => stringInput(toolInput, 'cwd'), envOf: stringEnv }],
    ['bash_async', { cwdOf: (toolInput) => stringInput(toolInput, 'cwd'), envOf: stringEnv }],
    ['bash_schedule', { cwdOf: (toolInput) => stringInput(toolInput, 'cwd'), envOf: stringEnv }],
  ])

  const FILE_TOOLS = new Map<string, FileConfig>([
    ['write', { actionOf: () => 'Write' as const }],
    ['edit', { actionOf: () => 'Edit' as const }],
  ])

  const FILE_PIPELINE_TOOLS = new Set(['read', 'edit'])

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus('gipi-safety', enabled ? 'safety ✓' : 'safety off')
  }

  function statusMessage(): string {
    return enabled
      ? 'gipi-safety on — dangerous commands prompt, plugin guards active'
      : 'gipi-safety off — confirmations and plugin guards skipped; secret and repo paths still blocked'
  }

  function setEnabled(next: boolean, ctx: ExtensionContext) {
    enabled = next
    updateStatus(ctx)
    ctx.ui.notify(statusMessage(), enabled ? 'info' : 'warning')
  }

  pi.registerCommand('safety', {
    description: 'Show or change the gipi-safety guard (on | off | status)',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'status') {
        ctx.ui.notify(statusMessage(), enabled ? 'info' : 'warning')
        return
      }
      if (arg && arg !== 'on' && arg !== 'off' && arg !== 'toggle') {
        ctx.ui.notify(`Unknown argument "${args.trim()}" — use on, off, or status`, 'error')
        return
      }
      setEnabled(arg === 'on' ? true : arg === 'off' ? false : !enabled, ctx)
    },
  })

  pi.registerShortcut(Key.alt('s'), {
    description: 'Toggle gipi-safety guard (/safety)',
    handler: async (ctx) => setEnabled(!enabled, ctx),
  })

  pi.on('before_agent_start', async (event) => {
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
    if (envDisabled && !enabled) {
      ctx.ui.notify(
        `gipi-safety off (${ENV_KEY}=${process.env[ENV_KEY]}) — /safety on enables it for this session`,
        'warning',
      )
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus('gipi-safety', undefined)
  })

  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.isProjectTrusted()) return

    const toolInput = inputRecord(event.input)
    const shellConfig = SHELL_TOOLS.get(event.toolName)
    const fileConfig = FILE_TOOLS.get(event.toolName)

    const isKillAction =
      isToolCallEventType('bash_async_manage', event) && event.input.action === 'kill'

    // Hard blocks are checked before the runtime switch: they protect secrets and
    // repo state and have no interactive override, so disabling the guard keeps them.
    const rawFileInput = fileConfig ? stringInput(toolInput, 'path') : undefined
    if (rawFileInput && isBlockedPath(resolveToolPath(ctx, rawFileInput))) {
      return {
        block: true,
        reason: `Blocked path: ${rawFileInput} — modifying this file risks secrets or data loss`,
      }
    }

    if (!enabled) return

    if (FILE_PIPELINE_TOOLS.has(event.toolName)) {
      const rawPath = isToolCallEventType('edit', event)
        ? event.input.path
        : stringInput(toolInput, 'path')
      if (!rawPath) return
      const path = resolveToolPath(ctx, rawPath)
      for (const plugin of PLUGINS) {
        const decision = await plugin.guardFile?.(event.toolName, path, ctx)
        if (decision === undefined) continue
        if ('allow' in decision) break
        if (decision.steer) pi.sendUserMessage(decision.steer, { deliverAs: 'steer' })
        return { block: true, reason: decision.reason }
      }
    }

    if (shellConfig) {
      const command =
        isToolCallEventType('bash', event) ||
        isToolCallEventType('bash_async', event) ||
        isToolCallEventType<'bash_schedule', { command: string }>('bash_schedule', event)
          ? event.input.command
          : stringInput(toolInput, 'command')
      if (!command) return
      for (const plugin of PLUGINS) {
        const session = pluginSessions.get(plugin.name) ?? new Map<string, string>()
        // biome-ignore lint/suspicious/noExplicitAny: guardShell type inference issue with ToolCallEvent union
        const decision: GuardDecision = await (plugin.guardShell as any)?.(
          event.toolName,
          command,
          ctx,
          session,
        )
        if (decision === undefined) continue
        if ('allow' in decision) break
        if (decision.steer) pi.sendUserMessage(decision.steer, { deliverAs: 'steer' })
        return { block: true, reason: decision.reason }
      }

      const isDestructive = isDangerousCommand(String(command))
      if (!isDestructive && !isKillAction) return

      if (isDestructive) {
        if (!ctx.hasUI) return { block: true, reason: BLOCKED_NO_UI }
        notifyStuck()
        const decision: Decision = await confirmBash(ctx, String(command), {
          cwd: shellConfig.cwdOf?.(toolInput) ?? ctx.cwd,
          env: shellConfig.envOf?.(toolInput),
        })
        resetStuckNotified()
        if (decision === 'no') return { block: true, reason: BLOCKED_REASON }
        if (typeof decision === 'object' && decision.kind === 'no-steer') {
          return { block: true, reason: decision.reason }
        }
        if (typeof decision === 'object' && decision.kind === 'yes-steer') {
          pi.sendUserMessage(decision.message, { deliverAs: 'steer' })
        }
        return
      }

      if (!ctx.hasUI) return { block: true, reason: BLOCKED_NO_UI }
      notifyStuck()
      const killDecision: Decision = await confirmBash(
        ctx,
        `bash_async_manage kill ${stringInput(toolInput, 'id') ?? '?'}`,
      )
      resetStuckNotified()
      if (killDecision === 'no') return { block: true, reason: BLOCKED_REASON }
      return
    }

    if (fileConfig) return

    if (isKillAction) {
      if (!ctx.hasUI) return { block: true, reason: BLOCKED_NO_UI }
      notifyStuck()
      const decision: Decision = await confirmBash(
        ctx,
        `bash_async_manage kill ${stringInput(toolInput, 'id') ?? '?'}`,
      )
      resetStuckNotified()
      if (decision === 'no') return { block: true, reason: BLOCKED_REASON }
      return
    }
  })
}
