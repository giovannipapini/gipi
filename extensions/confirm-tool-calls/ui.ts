import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

export type Decision =
  | 'yes'
  | 'yes-always'
  | 'no'
  | { kind: 'yes-steer'; message: string }
  | { kind: 'no-steer'; reason: string }

const MAX_DISPLAY = 400

function truncate(s: string): string {
  if (s.length <= MAX_DISPLAY) return s
  return `${s.slice(0, MAX_DISPLAY)}\n… (+${s.length - MAX_DISPLAY} chars)`
}

type OptionDef = { label: string; value: 'yes' | 'yes-always' | 'no'; canNote: boolean }

const OPTIONS: OptionDef[] = [
  { label: 'Yes', value: 'yes', canNote: true },
  { label: 'Yes, always (this session)', value: 'yes-always', canNote: false },
  { label: 'No', value: 'no', canNote: true },
]

async function showConfirm(ctx: ExtensionContext, title: string): Promise<Decision> {
  return ctx.ui.custom<Decision>((tui, theme, _kb, done) => {
    let optionIndex = 0
    let noteMode = false
    let cachedLines: string[] | undefined

    const noteInput = new Input()

    noteInput.onSubmit = (value) => {
      const note = value.trim()
      const opt = OPTIONS[optionIndex]
      if (opt.value === 'yes') {
        done(note ? { kind: 'yes-steer', message: note } : 'yes')
      } else {
        done(note ? { kind: 'no-steer', reason: note } : 'no')
      }
    }

    noteInput.onEscape = () => {
      noteMode = false
      noteInput.setValue('')
      noteInput.focused = false
      refresh()
    }

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    function handleInput(data: string) {
      if (noteMode) {
        noteInput.handleInput(data)
        refresh()
        return
      }

      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1)
        refresh()
        return
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(OPTIONS.length - 1, optionIndex + 1)
        refresh()
        return
      }
      if (matchesKey(data, Key.tab)) {
        if (OPTIONS[optionIndex].canNote) {
          noteMode = true
          noteInput.setValue('')
          noteInput.focused = true
          refresh()
        }
        return
      }
      if (matchesKey(data, Key.enter)) {
        done(OPTIONS[optionIndex].value)
        return
      }
      if (matchesKey(data, Key.escape)) {
        done('no')
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines

      const lines: string[] = []
      const add = (s: string) => lines.push(truncateToWidth(s, width))

      add(theme.fg('accent', '─'.repeat(width)))
      for (const line of title.split('\n')) {
        add(theme.fg('text', ` ${line}`))
      }
      lines.push('')

      for (let i = 0; i < OPTIONS.length; i++) {
        const opt = OPTIONS[i]
        const selected = i === optionIndex
        const prefix = selected ? theme.fg('accent', '> ') : '  '
        const label = opt.label + (noteMode && selected ? ' ✎' : '')
        add(`${prefix}${selected ? theme.fg('accent', label) : theme.fg('text', label)}`)
      }

      if (noteMode) {
        lines.push('')
        add(theme.fg('muted', ' Note:'))
        for (const line of noteInput.render(width - 4)) {
          add(`  ${line}`)
        }
        lines.push('')
        add(theme.fg('dim', ' Enter to confirm • Esc to cancel note'))
      } else {
        const tabHint = OPTIONS[optionIndex].canNote ? ' • Tab to add a note' : ''
        lines.push('')
        add(theme.fg('dim', ` ↑↓ navigate • Enter select • Esc cancel${tabHint}`))
      }

      add(theme.fg('accent', '─'.repeat(width)))

      cachedLines = lines
      return lines
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined
      },
      handleInput,
    }
  })
}

export async function confirmBash(
  ctx: ExtensionContext,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<Decision> {
  let title = `Run command?\n\n${truncate(command)}`
  if (opts?.cwd) title += `\n\ncwd: ${opts.cwd}`
  if (opts?.env && Object.keys(opts.env).length > 0) {
    const envLines = Object.entries(opts.env)
      .map(([k, v]) => `  ${k}=${truncate(v)}`)
      .join('\n')
    title += `\n\nenv:\n${envLines}`
  }
  return showConfirm(ctx, title)
}

export async function confirmFileOp(
  ctx: ExtensionContext,
  action: 'Write' | 'Edit' | 'Create',
  path: string,
): Promise<Decision> {
  return showConfirm(ctx, `${action} file?\n\n${path}`)
}

export async function confirmBackgroundKill(
  ctx: ExtensionContext,
  id: string | undefined,
): Promise<Decision> {
  return showConfirm(ctx, `Kill background job?\n\n${id ?? '(missing job id)'}`)
}

export type SubstitutionDecision = 'steer' | 'steer-always' | 'allow' | 'allow-always'

export async function promptSubstitution(
  ctx: ExtensionContext,
  swapStr: string,
  preferred: string[],
): Promise<SubstitutionDecision> {
  const OPTS: Array<{ label: string; value: SubstitutionDecision }> = [
    { label: `Rewrite using ${preferred.join('/')}`, value: 'steer' },
    { label: 'Rewrite always (this session)', value: 'steer-always' },
    { label: 'Allow as-is', value: 'allow' },
    { label: 'Allow always (this session)', value: 'allow-always' },
  ]

  return ctx.ui.custom<SubstitutionDecision>((tui, theme, _kb, done) => {
    let selected = 0
    let cachedLines: string[] | undefined

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        selected = Math.max(0, selected - 1)
      } else if (matchesKey(data, Key.down)) {
        selected = Math.min(OPTS.length - 1, selected + 1)
      } else if (matchesKey(data, Key.enter)) {
        done(OPTS[selected].value)
        return
      } else if (matchesKey(data, Key.escape)) {
        done('allow')
        return
      }
      cachedLines = undefined
      tui.requestRender()
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines

      const lines: string[] = []
      const add = (s: string) => lines.push(truncateToWidth(s, width))

      add(theme.fg('accent', '─'.repeat(width)))
      add(theme.fg('text', ` Non-preferred tool: ${swapStr}`))
      lines.push('')
      for (let i = 0; i < OPTS.length; i++) {
        const { label } = OPTS[i]
        const active = i === selected
        const prefix = active ? theme.fg('accent', '> ') : '  '
        add(`${prefix}${active ? theme.fg('accent', label) : theme.fg('text', label)}`)
      }
      lines.push('')
      add(theme.fg('dim', ' ↑↓ navigate • Enter select • Esc allow'))
      add(theme.fg('accent', '─'.repeat(width)))

      cachedLines = lines
      return lines
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined
      },
      handleInput,
    }
  })
}
