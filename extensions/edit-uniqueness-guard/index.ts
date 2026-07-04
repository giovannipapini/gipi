import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

// single O(n) pass: walk content once in sorted position order → line numbers
function positionsToLines(content: string, positions: number[]): number[] {
  const lines: number[] = []
  let lineNum = 1
  let charIdx = 0
  for (const pos of positions) {
    while (charIdx < pos) {
      if (content[charIdx] === '\n') lineNum++
      charIdx++
    }
    lines.push(lineNum)
  }
  return lines
}

function findPositions(content: string, target: string): number[] {
  const positions: number[] = []
  let pos = content.indexOf(target, 0)
  while (pos !== -1) {
    positions.push(pos)
    pos = content.indexOf(target, pos + target.length)
  }
  return positions
}

export default function editUniquenessGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('edit', event)) return
    // event.input is now typed as EditToolInput:
    // { path: string; edits: Array<{ oldText: string; newText: string }> }

    const { path, edits } = event.input
    if (!path || !edits?.length) return

    if (ctx.signal?.aborted) return

    let content: string
    try {
      content = await readFile(resolve(ctx.cwd, path), 'utf-8')
    } catch {
      return
    }

    if (ctx.signal?.aborted) return

    const problems: string[] = []
    for (const edit of edits) {
      if (!edit.oldText) continue
      const positions = findPositions(content, edit.oldText)
      if (positions.length <= 1) continue
      const lineNums = positionsToLines(content, positions).join(', ')
      problems.push(`oldText matches ${positions.length} locations (lines ${lineNums})`)
    }

    if (problems.length === 0) return

    return {
      block: true,
      reason: `edit blocked for ${path}: ${problems.join('; ')}. Read those line ranges and include unique surrounding context in oldText.`,
    }
  })
}
