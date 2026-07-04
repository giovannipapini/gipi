/**
 * gipi-background Extension
 *
 * Two tools: `bash_async` spawns a long-running shell command and returns
 * immediately; `bash_async_manage` reads stdout/stderr, kills, or lists jobs
 * started by it. Inspired by Claude Code's run_in_background.
 *
 * A `/jobs` command opens an interactive TUI manager for the user to browse,
 * live-tail, and kill background jobs without spending an agent turn.
 *
 * Jobs are session-scoped: logs spool to <agentDir>/gipi-background/<sessionId>/,
 * registry is persisted to jobs.json. The whole tree is killed on quit; on
 * /reload (and session replacement) jobs survive and are re-attached.
 *
 * Placement: ~/.pi/agent/extensions/gipi-background/index.ts (symlinked from dotfiles).
 */

import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { createRegistry, type JobRegistry, readLogTail } from './jobs.js'
import { loadJobs, purgeSessionDir } from './store.js'
import type { Job } from './types.js'

const EXEC_PROMPT_SNIPPET =
  'Run a shell command in the background and return immediately. ' +
  'Use this instead of `bash` for anything that does not finish promptly — dev servers, file watchers, long builds you want to observe live. ' +
  'Read its output later with bash_async_manage (action=stdout/stderr) and always bash_async_manage (action=kill) when done.'

const MANAGE_PROMPT_SNIPPET =
  'Read output from, kill, or list background jobs started with bash_async. ' +
  'action=stdout/stderr returns new bytes since the last read (set since_last_read=false for a full tail). ' +
  'action=kill terminates a job. action=list shows all jobs in this session.'

const PREVIEW_DELAY_MS = 250
const PREVIEW_BYTES = 4096
const PREVIEW_LINES = 20
const DEFAULT_TAIL_BYTES = 16 * 1024
const MAX_TAIL_BYTES = 256 * 1024

function fmtJob(j: Job): string {
  const dur = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000
  const exit = j.exitCode === undefined || j.exitCode === null ? '' : ` exit=${j.exitCode}`
  return `${j.id} pid=${j.pid} status=${j.status}${exit} dur=${dur.toFixed(1)}s cwd=${j.cwd}\n  $ ${j.command}`
}

function previewTail(content: string): string {
  if (!content) return ''
  const t = truncateTail(content, { maxBytes: PREVIEW_BYTES, maxLines: PREVIEW_LINES })
  return t.content
}

function statusLabel(reg: JobRegistry): string | undefined {
  const running = reg.getAll().filter((j) => j.status === 'running').length
  if (running === 0) return undefined
  return `bg:${running} ·`
}

const STATUS_GLYPH: Record<Job['status'], string> = {
  running: '●',
  exited: '✓',
  killed: '✗',
  failed: '✗',
}

const STATUS_COLOR: Record<Job['status'], string> = {
  running: 'accent',
  exited: 'success',
  killed: 'warning',
  failed: 'error',
}

const MANAGER_TAIL_BYTES = 64 * 1024
const MANAGER_OUTPUT_LINES = 18
const MANAGER_POLL_MS = 700

function fmtDur(j: Job): string {
  const s = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000
  if (s < 60) return `${s.toFixed(0)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export default function extension(pi: ExtensionAPI) {
  let registry: JobRegistry | undefined
  let sessionId: string | undefined

  function ensureRegistry(ctx: ExtensionContext): JobRegistry {
    const id = ctx.sessionManager.getSessionId()
    if (registry && sessionId === id) return registry
    sessionId = id
    registry = createRegistry(id, () => ctx.ui.setStatus('gipi-background', statusLabel(registry)))
    registry.restoreFromDisk(loadJobs(id))
    ctx.ui.setStatus('gipi-background', statusLabel(registry))
    return registry
  }

  function requireJob(reg: JobRegistry, id: string | undefined): Job {
    if (!id) throw new Error('`id` is required')
    const job = reg.get(id)
    if (!job) throw new Error(`Unknown job id: ${id}`)
    return job
  }

  pi.registerTool({
    name: 'bash_async',
    label: 'Bash (background)',
    description:
      'Spawn a long-running shell command and return immediately with a job id. ' +
      'Prefer this over the bash tool for anything that does not return promptly: dev servers, file watchers, long builds you want to observe live. ' +
      'Read output, kill, or list jobs with the bash_async_manage tool.',
    promptSnippet: EXEC_PROMPT_SNIPPET,
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        description: 'Shell command to run in the background.',
      }),
      cwd: Type.Optional(
        Type.String({ description: 'Working directory. Defaults to the session cwd.' }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: 'Hard kill after N seconds.', minimum: 1, maximum: 86_400 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)
      const job = reg.startJob({
        command: params.command,
        cwd: params.cwd ?? ctx.cwd,
        timeoutSeconds: params.timeout_seconds,
      })
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(t)
          resolve()
        }
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, PREVIEW_DELAY_MS)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      const live = reg.get(job.id) as Job
      const outPrev = previewTail(readLogTail(live.stdoutPath, 0, PREVIEW_BYTES, false).content)
      const errPrev = previewTail(readLogTail(live.stderrPath, 0, PREVIEW_BYTES, false).content)
      const text = [
        `Started ${live.id} pid=${live.pid} status=${live.status}`,
        `  $ ${live.command}`,
        `  cwd=${live.cwd}`,
        outPrev ? `--- stdout (preview) ---\n${outPrev}` : `(no stdout yet)`,
        errPrev ? `--- stderr (preview) ---\n${errPrev}` : `(no stderr yet)`,
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    },
  })

  pi.registerTool({
    name: 'bash_async_manage',
    label: 'Bash (background) manage',
    description:
      'Read output from, kill, or list background jobs started with bash_async. ' +
      'action=stdout/stderr reads new output (since_last_read=false for a full tail); ' +
      'action=kill terminates a job by id; action=list shows all jobs in this session.',
    promptSnippet: MANAGE_PROMPT_SNIPPET,
    parameters: Type.Object({
      action: StringEnum(['stdout', 'stderr', 'kill', 'list'] as const, {
        description: 'What to do: stdout | stderr | kill | list',
      }),
      id: Type.Optional(Type.String({ description: 'Job id (required for stdout/stderr/kill).' })),
      tail_bytes: Type.Optional(
        Type.Number({
          description: 'Max bytes to return (stdout/stderr). Default 16384.',
          minimum: 1,
          maximum: MAX_TAIL_BYTES,
        }),
      ),
      since_last_read: Type.Optional(
        Type.Boolean({
          description: 'stdout/stderr: only new bytes since last read. Default true.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reg = ensureRegistry(ctx)
      const action = params.action

      if (action === 'list') {
        const all = reg.getAll()
        if (all.length === 0) return { content: [{ type: 'text', text: '(no background jobs)' }] }
        return { content: [{ type: 'text', text: all.map(fmtJob).join('\n') }] }
      }

      if (action === 'kill') {
        const job = requireJob(reg, params.id)
        if (job.status !== 'running') {
          return {
            content: [
              {
                type: 'text',
                text: `${job.id} already ${job.status} (exit=${job.exitCode ?? '?'})`,
              },
            ],
          }
        }
        const ok = reg.killJob(job.id, 'SIGTERM')
        const text = ok
          ? `Sent SIGTERM to ${job.id} (pid=${job.pid}). Will SIGKILL after 1s if still alive.`
          : `Could not signal ${job.id} (pid=${job.pid}) — process may have already exited.`
        return { content: [{ type: 'text', text }] }
      }

      if (action !== 'stdout' && action !== 'stderr') {
        const _exhaustive: never = action
        throw new Error(`Unknown action: ${_exhaustive}`)
      }
      const job = requireJob(reg, params.id)
      const tailBytes = Math.max(
        1,
        Math.min(params.tail_bytes ?? DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES),
      )
      const sinceLast = params.since_last_read ?? true
      const path = action === 'stdout' ? job.stdoutPath : job.stderrPath
      const fromOffset = action === 'stdout' ? job.stdoutOffset : job.stderrOffset
      const r = readLogTail(path, fromOffset, tailBytes, sinceLast)
      if (sinceLast) {
        if (action === 'stdout') reg.updateOffsets(job.id, r.newOffset, job.stderrOffset)
        else reg.updateOffsets(job.id, job.stdoutOffset, r.newOffset)
      }
      const trunc = truncateTail(r.content, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      })
      const skipped = r.bytesSkipped > 0 ? ` skipped=${r.bytesSkipped}` : ''
      const truncated = trunc.truncated ? ` truncated` : ''
      const header = `[${job.id} ${action} status=${job.status} bytes=${r.bytesRead} file_size=${r.fileSize}${skipped}${truncated}]`
      const body = trunc.content || '(no new output)'
      return { content: [{ type: 'text', text: `${header}\n${body}` }] }
    },
  })

  pi.registerCommand('jobs', {
    description: 'Open the background-jobs manager (browse, live-tail, kill)',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('Jobs manager needs an interactive UI', 'warning')
        return
      }
      const reg = ensureRegistry(ctx)

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let selected = 0
        let stream: 'stdout' | 'stderr' = 'stdout'
        let notice = ''

        const timer = setInterval(() => tui.requestRender(), MANAGER_POLL_MS)
        function finish() {
          clearInterval(timer)
          done()
        }

        function jobs(): Job[] {
          return reg.getAll()
        }

        function selectedJob(): Job | undefined {
          const all = jobs()
          if (all.length === 0) return undefined
          selected = Math.max(0, Math.min(selected, all.length - 1))
          return all[selected]
        }

        function outputLines(job: Job, width: number): string[] {
          const path = stream === 'stdout' ? job.stdoutPath : job.stderrPath
          const r = readLogTail(path, 0, MANAGER_TAIL_BYTES, false)
          const trunc = truncateTail(r.content, {
            maxLines: MANAGER_OUTPUT_LINES,
            maxBytes: MANAGER_TAIL_BYTES,
          })
          const raw = trunc.content.replace(/\n$/, '')
          if (!raw) return [theme.fg('dim', `  (no ${stream} yet)`)]
          return raw.split('\n').map((l) => `  ${truncateToWidth(l, width - 2)}`)
        }

        function handleInput(data: string) {
          const all = jobs()
          if (matchesKey(data, Key.escape) || data === 'q') {
            finish()
            return
          }
          if (matchesKey(data, Key.up)) {
            selected = Math.max(0, selected - 1)
          } else if (matchesKey(data, Key.down)) {
            selected = Math.min(Math.max(0, all.length - 1), selected + 1)
          } else if (matchesKey(data, Key.tab) || data === 's') {
            stream = stream === 'stdout' ? 'stderr' : 'stdout'
          } else if (data === 'k') {
            const job = selectedJob()
            if (!job) {
              notice = ''
            } else if (job.status !== 'running') {
              notice = `${job.id} already ${job.status}`
            } else {
              reg.killJob(job.id, 'SIGTERM')
              notice = `Sent SIGTERM to ${job.id}`
            }
          } else {
            return
          }
          tui.requestRender()
        }

        function render(width: number): string[] {
          const lines: string[] = []
          const all = jobs()
          const running = all.filter((j) => j.status === 'running').length
          const add = (s: string) => lines.push(truncateToWidth(s, width))

          add(theme.fg('accent', '─'.repeat(width)))
          add(
            theme.fg('accent', theme.bold(` Background jobs `)) +
              theme.fg('muted', `${all.length} total · ${running} running`),
          )
          lines.push('')

          if (all.length === 0) {
            add(theme.fg('dim', '  No background jobs in this session.'))
          } else {
            all.forEach((j, i) => {
              const sel = i === selected
              const glyph = theme.fg(STATUS_COLOR[j.status], STATUS_GLYPH[j.status])
              const exit =
                j.exitCode === undefined || j.exitCode === null ? '' : ` exit=${j.exitCode}`
              const meta = theme.fg('muted', `${j.status}${exit} ${fmtDur(j)}`)
              const cmd = sel ? theme.fg('text', j.command) : theme.fg('dim', j.command)
              const prefix = sel ? theme.fg('accent', '> ') : '  '
              add(`${prefix}${glyph} ${theme.fg(sel ? 'accent' : 'text', j.id)} ${meta}  $ ${cmd}`)
            })
          }

          const job = selectedJob()
          if (job) {
            lines.push('')
            const tabFor = (s: 'stdout' | 'stderr') =>
              s === stream
                ? theme.bg('selectedBg', theme.fg('text', ` ${s} `))
                : theme.fg('muted', ` ${s} `)
            add(
              `${theme.fg('dim', ' ── ')}${tabFor('stdout')}${tabFor('stderr')}${theme.fg('dim', ` ── ${job.id} ──`)}`,
            )
            for (const l of outputLines(job, width)) lines.push(l)
          }

          lines.push('')
          if (notice) add(theme.fg('warning', ` ${notice}`))
          add(theme.fg('dim', ' ↑↓ select • Tab/s stdout·stderr • k kill • Esc/q close'))
          add(theme.fg('accent', '─'.repeat(width)))
          return lines
        }

        return { render, invalidate: () => {}, handleInput }
      })
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    ensureRegistry(ctx)
  })

  pi.on('session_tree', async (_event, ctx) => {
    // Same session, same jobs — just refresh the status label binding.
    ensureRegistry(ctx)
    ctx.ui.setStatus('gipi-background', statusLabel(registry))
  })

  pi.on('session_shutdown', async (event, ctx) => {
    ctx.ui.setStatus('gipi-background', undefined)
    if (!registry || !sessionId) return
    // Only tear down for real exits. Reload/replacement keep the persisted
    // registry on disk so jobs can be re-attached by the next session_start.
    if (event.reason === 'quit') {
      await registry.killAll()
      registry.persist()
      purgeSessionDir(sessionId)
    } else {
      registry.persist()
    }
    registry = undefined
    sessionId = undefined
  })
}
