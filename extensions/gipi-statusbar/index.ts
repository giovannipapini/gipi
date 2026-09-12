/**
 * gipi-statusbar extension — replaces the built-in pi footer with a richer status line.
 * Extension statuses are sorted alphabetically on the right side.
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

  // Agent running state
  let agentRunning = false
  // Tab title state — stored from session_start
  let setTitle: ((title: string) => void) | undefined
  let sessionId = ''
  let sessionName = ''

  /** Full path with ~/ for home directory. */
  function displayPath(p: string): string {
    const home = process.env.HOME
    return home && p.startsWith(home) ? p.replace(home, '~') : p
  }

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

  // ─── Tab / Window Title ────────────────────────────────────────────────────

  /** Set the terminal tab/window title using the stored ctx.ui.setTitle. */
  function updateTabTitle() {
    if (sessionName) {
      setTitle?.(`pi-agent (${sessionName})`)
    } else {
      setTitle?.(`pi-agent #${sessionId}`)
    }
  }

  // ─── Git ────────────────────────────────────────────────────────────────────

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

  // ─── Formatting Helpers ─────────────────────────────────────────────────────

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

  // ─── Shortcuts ──────────────────────────────────────────────────────────────

  addShortcut(
    Key.ctrlShift('h'),
    'ctrl+shift+h',
    'shortcuts',
    'Show all keyboard shortcuts (/hotkeys)',
    async (ctx) => {
      ctx.ui.setEditorText('/hotkeys')
    },
  )

  // ─── Events ─────────────────────────────────────────────────────────────────

  // Sync thinking level when changed externally (e.g. via /thinking command)
  pi.on('thinking_level_select', async () => {
    currentThinkingLevel = currentPiThinkingLevel()
    requestRender()
  })

  pi.on('model_select', async () => {
    requestRender()
  })

  pi.on('session_start', async (_event, ctx) => {
    renderCallbacks = []
    currentThinkingLevel = currentPiThinkingLevel()
    refreshSessionCost(ctx)
    agentRunning = false

    requestGitRefresh(ctx.cwd)

    // Set initial tab title — setTimeout to run after pi's own updateTerminalTitle()
    sessionId = ctx.sessionManager.getSessionId() ?? ''
    sessionName = pi.getSessionName() ?? ''
    setTitle = (title: string) => ctx.ui.setTitle(title)
    setTimeout(() => updateTabTitle(), 0)

    // Footer bar
    ctx.ui.setFooter((tui, theme, footerData) => {
      const footerRender = () => tui.requestRender()
      renderCallbacks.push(footerRender)
      const unsubBranch = footerData.onBranchChange(() => {
        tui.requestRender()
      })

      return {
        dispose: () => {
          renderCallbacks = renderCallbacks.filter((cb) => cb !== footerRender)
          unsubBranch()
        },
        invalidate() {},
        render(width: number): string[] {
          const sep = theme.fg('dim', ' │ ')

          const dir = displayPath(ctx.cwd)
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

          // Only show cost when it's non-zero (shows clean "—" when no cost)
          let costSegment: string
          if (totalCost > 0) {
            const costStr = totalCost.toFixed(3)
            costSegment = theme.fg('dim', '$') + theme.fg('success', costStr)
          } else {
            costSegment = theme.fg('dim', '$—')
          }

          // Agent running indicator
          const runningIndicator = agentRunning ? ` ${theme.fg('accent', '●')}` : ''

          let gitSegment = ''
          let diffSegment = ''
          const branch = footerData.getGitBranch()
          if (branch) {
            // Sync indicator: ≡ up-to-date, ↑N ahead, ↓N behind, ↕ diverged
            let sync = ''
            if (gitState) {
              const { ahead, behind } = gitState
              if (ahead > 0 && behind > 0) {
                sync = theme.fg('warning', ` ↕${ahead}↑${behind}↓`)
              } else if (ahead > 0) {
                sync = theme.fg('success', ` ↑${ahead}`)
              } else if (behind > 0) {
                sync = theme.fg('warning', ` ↓${behind}`)
              } else {
                sync = theme.fg('dim', ' ≡')
              }
            }
            gitSegment = theme.fg('accent', branch) + sync
            if (gitState) {
              if (gitState.dirty > 0) gitSegment += ` ${theme.fg('warning', `~${gitState.dirty}`)}`
              if (gitState.untracked > 0)
                gitSegment += ` ${theme.fg('muted', `?${gitState.untracked}`)}`
              if (gitState.linesAdded > 0 || gitState.linesRemoved > 0) {
                diffSegment =
                  theme.fg('toolDiffAdded', `+${gitState.linesAdded}`) +
                  theme.fg('dim', '/') +
                  theme.fg('toolDiffRemoved', `-${gitState.linesRemoved}`)
              }
            }
          }

          // Extension statuses from other extensions — sorted alphabetically by key
          const statusEntries = [...footerData.getExtensionStatuses().entries()]
            .filter(([, v]) => v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, v]) => v)
          const statusesSegment = statusEntries.join(' · ')

          let left = ` ${dirSegment}${runningIndicator}${sep}${modelSegment}${sep}${thinkSegment}${sep}${ctxSegment}${sep}${costSegment}`
          if (gitSegment) left += `${sep}${gitSegment}`
          if (diffSegment) left += `${sep}${diffSegment}`

          const right = statusesSegment ? ` ${statusesSegment} ` : ''
          const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
          const statusLine = truncateToWidth(left + ' '.repeat(pad) + right, width)

          // Hints line rendered below the status bar
          const dot = theme.fg('dim', '  ·  ')
          const h = shortcutHints.map(({ display, label }) => rawKeyHint(display, label)).join(dot)
          const hintsLine = h ? ` ${h}` : ''

          return [statusLine, '', hintsLine]
        },
      }
    })
  })

  pi.on('agent_start', async () => {
    agentRunning = true
    requestRender()
  })

  pi.on('agent_end', async (_event, ctx) => {
    agentRunning = false
    refreshSessionCost(ctx)
    requestGitRefresh(ctx.cwd)
    requestRender()
  })

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role === 'assistant' && event.message.usage?.cost?.total != null) {
      refreshSessionCost(ctx)
      requestRender()
    }
  })

  // Re-apply tab title when session info changes (pi restores default title)
  pi.on('session_info_changed', async (event) => {
    sessionName = event.name ?? ''
    updateTabTitle()
  })

  pi.on('session_shutdown', async () => {
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer)
    gitRefreshTimer = undefined
    queuedGitCwd = undefined
    renderCallbacks = []

    // Reset tab title on shutdown
    process.stdout.write('\x1b]0;\x07')
  })
}
