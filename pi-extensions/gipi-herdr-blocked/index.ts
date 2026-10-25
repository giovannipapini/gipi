/**
 * gipi-herdr-blocked — marks pi `blocked` in Herdr while a blocking UI prompt
 * waits for the user.
 *
 * Pi fires `ui_prompt_start` / `ui_prompt_end` around every extension dialog
 * (`ctx.ui.select`, `confirm`, `input`, `editor`, `custom`), so this covers
 * ask_user_question questionnaires, gipi-safety command confirmations, and any
 * other extension prompt. Herdr's pi integration (`herdr-agent-state.ts`,
 * installed by Herdr) flips the agent to `blocked` on a `herdr:blocked` event
 * with `{ active, label }` — but nothing emitted it, so the sidebar kept
 * showing `working` while pi waited for input.
 *
 * rpiv's `rpiv:ask-user:prompt` event is used only to improve the label: its
 * questionnaire is a custom UI without a title, so the label falls back to the
 * first question's header.
 *
 * No-ops outside Herdr (`HERDR_ENV` != 1).
 */

import type {
  ExtensionAPI,
  UIPromptKind,
  UIPromptStartEvent,
} from '@earendil-works/pi-coding-agent'

const HERDR_BLOCKED_EVENT = 'herdr:blocked'
const RPIV_PROMPT_EVENT = 'rpiv:ask-user:prompt'

const MAX_QUESTION_LABEL_CHARS = 60

const KIND_LABELS: Record<UIPromptKind, string> = {
  select: 'Choose an option',
  confirm: 'Confirm',
  input: 'Input required',
  editor: 'Edit text',
  custom: 'Waiting for your answer',
}

interface AskUserPromptPayload {
  questions?: ReadonlyArray<{ question: string; header: string }>
}

function computeQuestionLabel(payload: unknown): string | undefined {
  const first = (payload as AskUserPromptPayload | undefined)?.questions?.[0]
  if (!first) return undefined
  const header = first.header?.trim() ?? ''
  if (header) return header
  const question = first.question.replace(/\s+/g, ' ').trim()
  return question.length <= MAX_QUESTION_LABEL_CHARS
    ? question
    : `${question.slice(0, MAX_QUESTION_LABEL_CHARS - 1)}…`
}

export default function extension(pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== '1') return

  let questionLabel: string | undefined

  pi.events.on(RPIV_PROMPT_EVENT, (payload) => {
    questionLabel = computeQuestionLabel(payload)
  })

  function blockedLabel(event: UIPromptStartEvent): string {
    const title = event.title?.trim()
    if (title) return title
    if (event.kind === 'custom' && questionLabel) return questionLabel
    return KIND_LABELS[event.kind]
  }

  pi.on('ui_prompt_start', (event) => {
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: blockedLabel(event) })
  })

  pi.on('ui_prompt_end', () => {
    questionLabel = undefined
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: false })
  })
}
