/**
 * gipi-namesession extension — names pi sessions.
 *
 * At t0 (session start) an unnamed session immediately gets a structured
 * default: `π · <project> · YYYYMMDDTHHMM` (local time), e.g.
 * `π · gipi · 20261025T0039`.  That is only a placeholder: after a few
 * exchanges the extension queues a follow-up asking the LLM to replace it
 * with a short lowercase descriptive name via the name_session tool —
 * llm-friendly labels like "refactor auth", "debug oom", "setup ci".
 */

import { basename } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** Prefix of the structured t0 default name; anything else was chosen deliberately. */
const DEFAULT_NAME_PREFIX = 'π · '

function isDefaultName(name: string | undefined): boolean {
  return name?.startsWith(DEFAULT_NAME_PREFIX) ?? false
}

/** `π · <project> · YYYYMMDDTHHMM` in local time. */
function defaultSessionName(cwd: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}`
  const project = basename(cwd) || 'session'
  return `${DEFAULT_NAME_PREFIX}${project} · ${stamp}`
}

export default function (pi: ExtensionAPI) {
  let isNamed = false
  let namingAttempts = 0
  let lastNudgeMsgCount = 0
  const MAX_ATTEMPTS = 2
  const MIN_USER_MSGS = 1

  // t0: give every unnamed session a structured default name before the LLM gets a say.
  pi.on('session_start', async (_event, ctx) => {
    isNamed = false
    namingAttempts = 0
    lastNudgeMsgCount = 0

    // Resumed/forked sessions keep whatever name they already carry, default or not.
    const existing = pi.getSessionName()?.trim()
    if (existing) {
      isNamed = !isDefaultName(existing)
      return
    }
    pi.setSessionName(defaultSessionName(ctx.cwd))
  })

  pi.registerTool({
    name: 'name_session',
    label: 'Name Session',
    description:
      'Set a short lowercase name for the current session based on the conversation so far',
    promptSnippet: 'Set session name to describe this session concisely',
    promptGuidelines: [
      'Use name_session to set a 1-3 word lowercase descriptive session name once the conversation has enough context',
      'Names should be concrete: "refactor auth", "debug oom", "setup ci" — not generic like "discussion"',
      'Keep names short (1-3 words), all lowercase, no punctuation or trailing whitespace',
    ],
    parameters: Type.Object({
      name: Type.String({
        description: 'Short lowercase session name (1-3 words, no punctuation)',
      }),
    }),
    async execute(_toolCallId, params) {
      pi.setSessionName(params.name.toLowerCase().trim())
      isNamed = true
      return {
        content: [{ type: 'text', text: `session named: ${params.name}` }],
        details: { name: params.name },
      }
    },
  })

  pi.on('session_info_changed', async (event) => {
    isNamed = event.name !== undefined && !isDefaultName(event.name)
  })

  pi.registerCommand('autoname', {
    description: 'Ask the LLM to infer and set a short lowercase session name',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      namingAttempts++
      pi.sendUserMessage(
        'use name_session to set a short lowercase name (1-3 words) for this session based on our conversation',
        { deliverAs: 'followUp' },
      )
    },
  })

  function isSubstantive(text: string): boolean {
    const trimmed = text.trim()
    if (trimmed.length < 15) return false
    // purely alpha+spaces = likely a greeting like "hi there"
    if (/^[a-zA-Z\s]+$/.test(trimmed)) return false
    return true
  }

  function lastUserMessage(ctx: ExtensionContext): string | undefined {
    for (const entry of ctx.sessionManager.getBranch().toReversed()) {
      if (entry.type === 'message' && entry.message.role === 'user') {
        const content = entry.message.content
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
          const text = content.find((c) => c.type === 'text')
          if (text && 'text' in text) return text.text
        }
        return undefined
      }
    }
    return undefined
  }

  pi.on('agent_settled', async (_event, ctx) => {
    if (isNamed || namingAttempts >= MAX_ATTEMPTS) return

    const branch = ctx.sessionManager.getBranch()
    const userCount = branch.filter((e) => e.type === 'message' && e.message.role === 'user').length

    if (lastNudgeMsgCount === 0 && userCount >= MIN_USER_MSGS) {
      // skip if the last user message looks like a greeting with no substance
      const last = lastUserMessage(ctx)
      if (last !== undefined && !isSubstantive(last)) return

      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        "if you have enough context now, use name_session to set a short lowercase name (1-3 words) for this session based on what we've been discussing",
        { deliverAs: 'followUp' },
      )
    } else if (
      lastNudgeMsgCount > 0 &&
      namingAttempts < MAX_ATTEMPTS &&
      userCount > lastNudgeMsgCount
    ) {
      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        'please use name_session to set a short lowercase session name before we continue',
        { deliverAs: 'followUp' },
      )
    }
  })
}
