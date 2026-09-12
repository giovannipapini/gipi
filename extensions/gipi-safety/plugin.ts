import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

export type GuardDecision =
  | { block: true; reason: string; steer?: string }
  | { allow: true }
  | undefined

export interface Plugin {
  name: string
  priority?: number
  claims?: string[]
  promptSection?(systemPrompt: string, claimed?: ReadonlySet<string>): string | undefined
  guardShell?(
    toolName: string,
    command: string,
    ctx: ExtensionContext,
    session: Map<string, string>,
  ): Promise<GuardDecision>
  guardFile?(toolName: string, path: string, ctx: ExtensionContext): Promise<GuardDecision>
  isSafeShellSegment?(segment: string): boolean
  isSafePath?(path: string): boolean
}
