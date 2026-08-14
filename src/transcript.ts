import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Codex Guardian's default transcript limits, expressed as approximate tokens. */
export const TRANSCRIPT_LIMITS = Object.freeze({
  messageEntryTokens: 2_000,
  toolEntryTokens: 1_000,
  messageTotalTokens: 10_000,
  toolTotalTokens: 10_000,
  recentNonUserEntries: 40,
  approvalReasonTokens: 512,
  actionStringTokens: 16_000,
})

type TranscriptKind = 'user' | 'checkpoint' | 'assistant' | 'tool'

/** One filtered parent-history entry before budget selection. */
export interface TranscriptEntry {
  readonly kind: TranscriptKind
  readonly role: string
  readonly text: string
}

/** Selected transcript lines and whether entries were omitted. */
export interface RenderedTranscript {
  readonly lines: string[]
  readonly omitted: boolean
}

function evidenceLabel(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return 'TRUSTED HUMAN MESSAGE'
    case 'checkpoint':
      return 'UNTRUSTED COMPACTION CHECKPOINT'
    case 'assistant':
      return 'UNTRUSTED ASSISTANT MESSAGE'
    case 'tool':
      return `UNTRUSTED ${entry.role.toUpperCase()}`
  }
}

/** Approximate token count using the same four-UTF-8-bytes heuristic as Codex. */
export function approximateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

function utf8Head(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maxBytes) break
    result += character
    bytes += width
  }
  return result
}

function utf8Tail(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  const characters = Array.from(text)
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]
    if (character === undefined) continue
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maxBytes) break
    result = character + result
    bytes += width
  }
  return result
}

/** UTF-8-safe head/tail truncation with a model-visible omission marker. */
export function truncateApproxTokens(text: string, tokenCap: number): { text: string; truncated: boolean } {
  const maxBytes = tokenCap * 4
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength <= maxBytes) return { text, truncated: false }

  const omittedTokens = Math.ceil(Math.max(0, byteLength - maxBytes) / 4)
  const marker = `<truncated omitted_approx_tokens="${omittedTokens}" />`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= maxBytes) return { text: marker, truncated: true }

  const remaining = maxBytes - markerBytes
  const headBytes = Math.floor(remaining / 2)
  const tailBytes = remaining - headBytes
  return {
    text: `${utf8Head(text, headBytes)}${marker}${utf8Tail(text, tailBytes)}`,
    truncated: true,
  }
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function visibleContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push(`[image attachment: ${jsonText(block.attachment)}]`)
        break
      case 'tool-result':
        parts.push(visibleContent(block.content))
        break
      case 'reasoning':
      case 'tool-call':
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Filter compacted parent history for automated approval review.
 *
 * Direct human messages and compaction checkpoints are retained. Assistant
 * reasoning and ordinary runtime/plugin context are excluded; visible
 * assistant text, tool calls, and tool results remain as evidence.
 */
export function collectTranscriptEntries(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const toolNames = new Map<string, string>()

  for (const message of messages) {
    if (message.source.kind === 'user') {
      const text = visibleContent(message.content)
      if (text.length > 0) entries.push({ kind: 'user', role: 'user', text })
      continue
    }

    if (isCompactCheckpointSource(message.source)) {
      const text = visibleContent(message.content)
      if (text.length > 0) entries.push({ kind: 'checkpoint', role: 'compaction checkpoint', text })
      continue
    }

    if (message.role === 'assistant') {
      const text = visibleContent(message.content)
      if (text.length > 0) entries.push({ kind: 'assistant', role: 'assistant', text })
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        toolNames.set(String(block.id), block.name)
        if (block.arguments.trim().length > 0) {
          entries.push({ kind: 'tool', role: `tool ${block.name} call`, text: block.arguments })
        }
      }
      continue
    }

    if (message.source.kind === 'tool') {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        const text = visibleContent(block.content)
        if (text.length === 0) continue
        const toolName = toolNames.get(String(block.toolCallId))
        entries.push({
          kind: 'tool',
          role: toolName === undefined ? 'tool result' : `tool ${toolName} result`,
          text,
        })
      }
    }
  }

  return entries
}

/** Select a bounded Codex-style transcript while preserving original numbering. */
export function renderTranscript(entries: readonly TranscriptEntry[]): RenderedTranscript {
  if (entries.length === 0) return { lines: ['<no retained transcript entries>'], omitted: false }

  const rendered = entries.map((entry, index) => {
    const cap = entry.kind === 'tool'
      ? TRANSCRIPT_LIMITS.toolEntryTokens
      : TRANSCRIPT_LIMITS.messageEntryTokens
    const truncated = truncateApproxTokens(entry.text, cap).text
    const line = `[${index + 1}] ${evidenceLabel(entry)}: ${truncated}`
    return { line, tokens: approximateTokens(line) }
  })

  const included = new Array<boolean>(entries.length).fill(false)
  let messageTokens = 0
  let toolTokens = 0
  const userIndices = entries
    .map((entry, index) => entry.kind === 'user' ? index : -1)
    .filter(index => index >= 0)

  const firstUser = userIndices[0]
  if (firstUser !== undefined) {
    included[firstUser] = true
    messageTokens += rendered[firstUser]?.tokens ?? 0
  }

  const lastUser = userIndices[userIndices.length - 1]
  if (lastUser !== undefined && !included[lastUser]) {
    const tokens = rendered[lastUser]?.tokens ?? 0
    if (messageTokens + tokens <= TRANSCRIPT_LIMITS.messageTotalTokens) {
      included[lastUser] = true
      messageTokens += tokens
    }
  }

  for (let offset = userIndices.length - 1; offset >= 0; offset -= 1) {
    const index = userIndices[offset]
    if (index === undefined || included[index]) continue
    const tokens = rendered[index]?.tokens ?? 0
    if (messageTokens + tokens > TRANSCRIPT_LIMITS.messageTotalTokens) continue
    included[index] = true
    messageTokens += tokens
  }

  let retainedNonUser = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.kind === 'user'
      || retainedNonUser >= TRANSCRIPT_LIMITS.recentNonUserEntries) continue
    const tokens = rendered[index]?.tokens ?? 0
    const withinBudget = entry.kind === 'tool'
      ? toolTokens + tokens <= TRANSCRIPT_LIMITS.toolTotalTokens
      : messageTokens + tokens <= TRANSCRIPT_LIMITS.messageTotalTokens
    if (!withinBudget) continue
    included[index] = true
    retainedNonUser += 1
    if (entry.kind === 'tool') toolTokens += tokens
    else messageTokens += tokens
  }

  return {
    lines: rendered.filter((_entry, index) => included[index]).map(entry => entry.line),
    omitted: included.some(value => !value),
  }
}

/** Recursively sort object keys and truncate every string in planned-action JSON. */
export function normalizeActionValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateApproxTokens(value, TRANSCRIPT_LIMITS.actionStringTokens).text
  }
  if (Array.isArray(value)) return value.map(normalizeActionValue)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeActionValue(entry)]),
  )
}
