/**
 * gipi-herdr-rpiv extension — bridges @juicesharp/rpiv-ask-user-question
 * dialogs into Herdr's agent lifecycle.
 *
 * While the questionnaire awaits input, rpiv emits `rpiv:ask-user:prompt`
 * (the questions) then `rpiv:ask-user:blocked` (`{active}`). Herdr's pi
 * integration (`herdr-agent-state.ts`, installed by Herdr) marks the agent
 * `blocked` on a `herdr:blocked` event with `{active, label}` — but nothing
 * emitted it. This extension forwards rpiv's events to Herdr's, labeling the
 * blocked state with the first question's header (falling back to truncated
 * question text), so the Herdr sidebar shows pi as blocked while you answer
 * and `herdr agent wait --until blocked` works.
 *
 * No-ops outside Herdr (`HERDR_ENV` != 1) and when rpiv is not installed —
 * the rpiv events simply never fire.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const RPIV_PROMPT_EVENT = 'rpiv:ask-user:prompt'
const RPIV_BLOCKED_EVENT = 'rpiv:ask-user:blocked'
const HERDR_BLOCKED_EVENT = 'herdr:blocked'

const MAX_QUESTION_LABEL_CHARS = 60
const FALLBACK_LABEL = 'Waiting for your answer'

interface AskUserPromptPayload {
  questions?: ReadonlyArray<{ question: string; header: string }>
}

interface AskUserBlockedPayload {
  active?: boolean
}

function computeBlockedLabel(payload: unknown): string | undefined {
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

  let activeLabel: string | undefined

  pi.events.on(RPIV_PROMPT_EVENT, (payload) => {
    activeLabel = computeBlockedLabel(payload)
  })

  pi.events.on(RPIV_BLOCKED_EVENT, (payload) => {
    const active = Boolean((payload as AskUserBlockedPayload | undefined)?.active)
    if (!active) activeLabel = undefined
    pi.events.emit(HERDR_BLOCKED_EVENT, {
      active,
      label: active ? (activeLabel ?? FALLBACK_LABEL) : undefined,
    })
  })
}
