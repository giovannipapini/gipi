import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

export type Decision =
  | 'yes'
  | 'yes-always'
  | 'no'
  | { kind: 'yes-steer'; message: string }
  | { kind: 'no-steer'; reason: string }

const MAX_DISPLAY_CHARS = 400

function truncate(s: string): string {
  if (s.length <= MAX_DISPLAY_CHARS) return s
  return `${s.slice(0, MAX_DISPLAY_CHARS)}\n… (+${s.length - MAX_DISPLAY_CHARS} chars)`
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
    let isEditingNote = false
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
      isEditingNote = false
      noteInput.setValue('')
      noteInput.focused = false
      invalidateAndRender()
    }

    function invalidateAndRender() {
      cachedLines = undefined
      tui.requestRender()
    }

    function onKeyPress(data: string) {
      if (isEditingNote) {
        noteInput.handleInput(data)
        invalidateAndRender()
        return
      }

      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1)
        invalidateAndRender()
        return
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(OPTIONS.length - 1, optionIndex + 1)
        invalidateAndRender()
        return
      }
      if (matchesKey(data, Key.tab)) {
        if (OPTIONS[optionIndex].canNote) {
          isEditingNote = true
          noteInput.setValue('')
          noteInput.focused = true
          invalidateAndRender()
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
        const label = opt.label + (isEditingNote && selected ? ' ✎' : '')
        add(`${prefix}${selected ? theme.fg('accent', label) : theme.fg('text', label)}`)
      }

      if (isEditingNote) {
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
      handleInput: onKeyPress,
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
