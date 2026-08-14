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

type TranscriptKind = 'user' | 'instruction' | 'question' | 'checkpoint' | 'assistant' | 'tool'

/** Trusted kinds that establish user authorization (shared anchor/budget handling). */
const TRUSTED_KINDS: ReadonlySet<TranscriptKind> = new Set(['user', 'instruction', 'question'])

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
    case 'instruction':
      return 'TRUSTED INSTRUCTION'
    case 'question':
      return 'TRUSTED QUESTION ANSWER'
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
 * Whether a message is workspace/developer instruction content (AGENTS.md and
 * compatible files) loaded by the harness. Such content is trusted and can
 * establish user authorization. It arrives as either the merge-extensible
 * `agent-instructions` source kind or a `plugin` source named
 * `agent-instructions` carrying the instructions `form`.
 */
function isInstructionSource(source: Message['source']): boolean {
  const candidate = source as { readonly kind?: unknown; readonly plugin?: unknown }
  if (candidate.kind === 'agent-instructions') return true
  return candidate.kind === 'plugin' && candidate.plugin === 'agent-instructions'
}

/** The tool name whose answer is a human-selected option under a question. */
const QUESTION_TOOL = 'ask_user_question'

/**
 * Whether an ask_user_question result carries a well-formed human answer worth
 * treating as trusted authorization. Only a successful result (isError ===
 * false) whose text parses to `{ answers: [{ id: string, selected: string[],
 * custom?: string }] }` qualifies; cancelled, malformed, or structure-less
 * output stays generated tool data.
 */
function isTrustedQuestionAnswer(text: string): boolean {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const answers = (payload as Record<string, unknown>).answers
  if (!Array.isArray(answers) || answers.length === 0) return false
  return answers.every(answer => {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return false
    const record = answer as Record<string, unknown>
    const id = record.id
    const selected = record.selected
    if (typeof id !== 'string' || id.length === 0) return false
    if (!Array.isArray(selected)) return false
    return selected.every(item => typeof item === 'string')
  })
}

/**
 * Filter compacted parent history for automated approval review.
 *
 * Direct human messages, workspace/developer instruction files (AGENTS.md),
 * human-selected question answers, and compaction checkpoints are retained.
 * Assistant reasoning and ordinary runtime/plugin context are excluded;
 * visible assistant text, tool calls, and tool results remain as evidence.
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

    if (isInstructionSource(message.source)) {
      const text = visibleContent(message.content)
      if (text.length > 0) entries.push({ kind: 'instruction', role: 'instructions', text })
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
        // Only a successful, well-formed ask_user_question answer is trusted
        // human authorization. A cancelled, unavailable, aborted, crashed, or
        // malformed result stays generated tool data, not a human selection.
        if (toolName === QUESTION_TOOL && block.isError === false && isTrustedQuestionAnswer(text)) {
          entries.push({ kind: 'question', role: `tool ${toolName} answer`, text })
          continue
        }
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
  const trustedIndices = entries
    .map((entry, index) => TRUSTED_KINDS.has(entry.kind) ? index : -1)
    .filter(index => index >= 0)

  const firstTrusted = trustedIndices[0]
  if (firstTrusted !== undefined) {
    included[firstTrusted] = true
    messageTokens += rendered[firstTrusted]?.tokens ?? 0
  }

  const lastTrusted = trustedIndices[trustedIndices.length - 1]
  if (lastTrusted !== undefined && !included[lastTrusted]) {
    const tokens = rendered[lastTrusted]?.tokens ?? 0
    if (messageTokens + tokens <= TRANSCRIPT_LIMITS.messageTotalTokens) {
      included[lastTrusted] = true
      messageTokens += tokens
    }
  }

  for (let offset = trustedIndices.length - 1; offset >= 0; offset -= 1) {
    const index = trustedIndices[offset]
    if (index === undefined || included[index]) continue
    const tokens = rendered[index]?.tokens ?? 0
    if (messageTokens + tokens > TRANSCRIPT_LIMITS.messageTotalTokens) continue
    included[index] = true
    messageTokens += tokens
  }

  let retainedNonTrusted = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || TRUSTED_KINDS.has(entry.kind)
      || retainedNonTrusted >= TRANSCRIPT_LIMITS.recentNonUserEntries) continue
    const tokens = rendered[index]?.tokens ?? 0
    const withinBudget = entry.kind === 'tool'
      ? toolTokens + tokens <= TRANSCRIPT_LIMITS.toolTotalTokens
      : messageTokens + tokens <= TRANSCRIPT_LIMITS.messageTotalTokens
    if (!withinBudget) continue
    included[index] = true
    retainedNonTrusted += 1
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
