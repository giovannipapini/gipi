/**
 * gipi-statusbar extension — replaces the built-in pi footer with a richer status line.
 *
 * Layout:
 *   dir │ model │ think:high │ ctx [▓▓▓░░░░░] 42% (85k/200k) │ $0.003 │ branch ~2 ?1 ↑1 │ +10/-5
 *                                               [extension statuses on the right]
 *
 * Shortcuts registered here:
 *   Ctrl+Shift+H — invoke /hotkeys
 *
 * A hints row is rendered below the status bar showing key bindings at a glance.
 * Git state is refreshed at session start and after each agent turn.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { rawKeyHint } from '@earendil-works/pi-coding-agent'
import { Key, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

interface GitState {
  dirty: number
  untracked: number
  ahead: number
  behind: number
  linesAdded: number
  linesRemoved: number
}

type ShortcutBinding = Parameters<ExtensionAPI['registerShortcut']>[0]
type ShortcutDefinition = Parameters<ExtensionAPI['registerShortcut']>[1]

export default function extension(pi: ExtensionAPI) {
  let gitState: GitState | null = null
  let currentThinkingLevel: ThinkingLevel = 'off'
  let renderCallbacks: Array<() => void> = []
  let totalCost = 0
  let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let gitRefreshInFlight = false
  let queuedGitCwd: string | undefined

  // Hints row entries — populated by addShortcut(); external entries inserted inline.
  const shortcutHints: Array<{ display: string; label: string }> = []

  /** Register a shortcut and add it to the hints row in one call. */
  function addShortcut(
    binding: ShortcutBinding,
    display: string,
    label: string,
    description: string,
    handler: ShortcutDefinition['handler'],
  ) {
    pi.registerShortcut(binding, { description, handler })
    shortcutHints.push({ display, label })
  }

  function requestRender() {
    for (const cb of renderCallbacks) cb()
  }

  function isThinkingLevel(level: string): level is ThinkingLevel {
    return THINKING_LEVELS.some((entry) => entry === level)
  }

  function currentPiThinkingLevel(): ThinkingLevel {
    const level = pi.getThinkingLevel()
    return typeof level === 'string' && isThinkingLevel(level) ? level : 'off'
  }

  function refreshSessionCost(ctx: ExtensionContext) {
    let nextCost = 0
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === 'message' && e.message.role === 'assistant') {
        const cost = e.message.usage?.cost?.total
        if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
          nextCost += cost
        }
      }
    }
    totalCost = Math.max(0, nextCost)
  }

  function requestGitRefresh(cwd: string) {
    queuedGitCwd = cwd
    if (gitRefreshTimer) return
    gitRefreshTimer = setTimeout(() => {
      gitRefreshTimer = undefined
      const next = queuedGitCwd
      queuedGitCwd = undefined
      if (next) void refreshGit(next)
    }, 150)
  }

  async function refreshGit(cwd: string) {
    if (gitRefreshInFlight) {
      queuedGitCwd = cwd
      return
    }
    gitRefreshInFlight = true
    try {
      const [statusRes, diffRes, aheadRes, behindRes] = await Promise.all([
        pi.exec('git', ['status', '--porcelain'], { cwd }),
        pi.exec('git', ['diff', '--shortstat', 'HEAD'], { cwd }),
        pi.exec('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd }),
        pi.exec('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd }),
      ])

      if (statusRes.code !== 0) {
        gitState = null
        requestRender()
        return
      }

      const statusLines = statusRes.stdout.split('\n').filter((l) => l.trim())
      const dirty = statusLines.filter((l) => !l.startsWith('??')).length
      const untracked = statusLines.filter((l) => l.startsWith('??')).length

      const addMatch = diffRes.stdout.match(/(\d+) insertion/)
      const remMatch = diffRes.stdout.match(/(\d+) deletion/)
      const linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0
      const linesRemoved = remMatch ? parseInt(remMatch[1], 10) : 0

      const ahead = aheadRes.code === 0 ? parseInt(aheadRes.stdout.trim(), 10) || 0 : 0
      const behind = behindRes.code === 0 ? parseInt(behindRes.stdout.trim(), 10) || 0 : 0

      gitState = { dirty, untracked, ahead, behind, linesAdded, linesRemoved }
    } catch {
      gitState = null
    } finally {
      gitRefreshInFlight = false
    }
    requestRender()
    if (queuedGitCwd) {
      const next = queuedGitCwd
      queuedGitCwd = undefined
      requestGitRefresh(next)
    }
  }

  function formatK(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
  }

  function miniBar(pct: number, width = 8): string {
    const filled = Math.min(Math.round((pct * width) / 100), width)
    return '▓'.repeat(filled) + '░'.repeat(width - filled)
  }

  function pctColor(pct: number): 'success' | 'warning' | 'error' {
    if (pct < 50) return 'success'
    if (pct < 80) return 'warning'
    return 'error'
  }

  function thinkColor(level: ThinkingLevel): 'dim' | 'success' | 'warning' | 'error' {
    if (level === 'off') return 'dim'
    if (level === 'minimal' || level === 'low') return 'success'
    if (level === 'medium') return 'warning'
    return 'error' // high, xhigh
  }

  // --- Shortcuts ---

  // External shortcuts from other extensions (gipi-safety)
  shortcutHints.push({ display: 'ctrl+shift+e', label: 'confirm' })
  shortcutHints.push({ display: 'ctrl+shift+w', label: 'writes' })

  addShortcut(
    Key.ctrlShift('h'),
    'ctrl+shift+h',
    'shortcuts',
    'Show all keyboard shortcuts (/hotkeys)',
    async (ctx) => {
      ctx.ui.setEditorText('/hotkeys')
    },
  )

  // Sync thinking level when changed externally (e.g. via /thinking command)
  pi.on('thinking_level_select', async () => {
    currentThinkingLevel = currentPiThinkingLevel()
    requestRender()
  })

  pi.on('session_start', async (_event, ctx) => {
    renderCallbacks = []
    currentThinkingLevel = currentPiThinkingLevel()
    refreshSessionCost(ctx)

    requestGitRefresh(ctx.cwd)

    // Footer bar
    ctx.ui.setFooter((tui, theme, footerData) => {
      const footerRender = () => tui.requestRender()
      renderCallbacks.push(footerRender)
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender())

      return {
        dispose: () => {
          renderCallbacks = renderCallbacks.filter((cb) => cb !== footerRender)
          unsubBranch()
        },
        invalidate() {},
        render(width: number): string[] {
          const sep = theme.fg('dim', ' │ ')

          const dir = ctx.cwd.split('/').pop() ?? ctx.cwd
          const dirSegment = theme.fg('accent', dir)

          const modelStr = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '—'
          const modelSegment = theme.fg('dim', modelStr)

          const tLevel = currentThinkingLevel
          const thinkSegment = theme.fg('dim', 'think:') + theme.fg(thinkColor(tLevel), tLevel)

          const usage = ctx.getContextUsage()
          let ctxSegment: string
          if (usage?.tokens != null && usage.contextWindow > 0) {
            const pct = Math.round(usage.percent ?? (usage.tokens * 100) / usage.contextWindow)
            const color = pctColor(pct)
            ctxSegment =
              theme.fg('dim', 'ctx') +
              ' [' +
              theme.fg(color, miniBar(pct)) +
              '] ' +
              theme.fg(color, `${pct}%`) +
              ' ' +
              theme.fg('dim', `(${formatK(usage.tokens)}/${formatK(usage.contextWindow)})`)
          } else {
            ctxSegment = theme.fg('dim', 'ctx —')
          }

          const costStr = totalCost > 0 ? totalCost.toFixed(3) : '0.000'
          const costColor = totalCost > 0 ? 'success' : 'dim'
          const costSegment = theme.fg('dim', '$') + theme.fg(costColor, costStr)

          let gitSegment = ''
          let diffSegment = ''
          const branch = footerData.getGitBranch()
          if (branch) {
            gitSegment = theme.fg('accent', branch)
            if (gitState) {
              if (gitState.dirty > 0) gitSegment += ` ${theme.fg('warning', `~${gitState.dirty}`)}`
              if (gitState.untracked > 0)
                gitSegment += ` ${theme.fg('muted', `?${gitState.untracked}`)}`
              if (gitState.ahead > 0) gitSegment += ` ${theme.fg('success', `↑${gitState.ahead}`)}`
              if (gitState.behind > 0)
                gitSegment += ` ${theme.fg('warning', `↓${gitState.behind}`)}`
              if (gitState.linesAdded > 0 || gitState.linesRemoved > 0) {
                diffSegment =
                  theme.fg('toolDiffAdded', `+${gitState.linesAdded}`) +
                  theme.fg('dim', '/') +
                  theme.fg('toolDiffRemoved', `-${gitState.linesRemoved}`)
              }
            }
          }

          // Extension statuses from other extensions
          const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean)
          const statusesSegment = statuses.join(' · ')

          let left = ` ${dirSegment}${sep}${modelSegment}${sep}${thinkSegment}${sep}${ctxSegment}${sep}${costSegment}`
          if (gitSegment) left += `${sep}${gitSegment}`
          if (diffSegment) left += `${sep}${diffSegment}`

          const right = statusesSegment ? ` ${statusesSegment} ` : ''
          const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
          const statusLine = truncateToWidth(left + ' '.repeat(pad) + right, width)

          // Hints line rendered below the status bar
          const dot = theme.fg('dim', '  ·  ')
          const hintsLine = ` ${shortcutHints.map(({ display, label }) => rawKeyHint(display, label)).join(dot)}`

          return [statusLine, '', hintsLine]
        },
      }
    })
  })

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role === 'assistant' && event.message.usage?.cost?.total != null) {
      refreshSessionCost(ctx)
      requestRender()
    }
  })

  pi.on('agent_end', async (_event, ctx) => {
    refreshSessionCost(ctx)
    requestGitRefresh(ctx.cwd)
    requestRender()
  })

  pi.on('session_shutdown', async () => {
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer)
    gitRefreshTimer = undefined
    queuedGitCwd = undefined
    renderCallbacks = []
  })
}
