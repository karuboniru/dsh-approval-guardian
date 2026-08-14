import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { buildReviewerPersona, buildReviewPrompt } from './policy.ts'
import type { EscalationEvidence, ResolvedConfig, ReviewerAssessment } from './types.ts'

const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['allow', 'deny'] },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    user_authorization: { type: 'string', enum: ['unknown', 'low', 'medium', 'high'] },
    rationale: { type: 'string' },
  },
  required: ['outcome'],
}

const reviewerStartParents = new AsyncLocalStorage<Agent>()
const reviewerAgents = new WeakSet<Agent>()

/** Identify an in-process approval reviewer during and after its publication. */
export function isApprovalReviewerAgent(agent: Agent): boolean {
  if (reviewerAgents.has(agent)) return true
  const parent = reviewerStartParents.getStore()
  return parent !== undefined
    && agent !== parent
    && agent.session.header.parentSession === parent.session.id
}

/** Typed failure category used to distinguish caller cancellation from reviewer failure. */
export class ReviewerError extends Error {
  constructor(
    message: string,
    readonly kind: 'cancelled' | 'timeout' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReviewerError'
  }
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T
  throw new ReviewerError(`approval reviewer returned an invalid ${field}`, 'unavailable')
}

/** Validate the structured result returned across the model-output boundary. */
export function parseAssessment(value: unknown): ReviewerAssessment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewerError('approval reviewer returned no structured decision', 'unavailable')
  }
  const record = value as Record<string, unknown>
  const outcome = optionalEnum(record.outcome, ['allow', 'deny'] as const, 'outcome')
  if (outcome === undefined) {
    throw new ReviewerError('approval reviewer omitted outcome', 'unavailable')
  }
  const riskLevel = optionalEnum(
    record.risk_level,
    ['low', 'medium', 'high', 'critical'] as const,
    'risk_level',
  )
  const userAuthorization = optionalEnum(
    record.user_authorization,
    ['unknown', 'low', 'medium', 'high'] as const,
    'user_authorization',
  )
  if (record.rationale !== undefined && typeof record.rationale !== 'string') {
    throw new ReviewerError('approval reviewer returned an invalid rationale', 'unavailable')
  }
  const rationale = typeof record.rationale === 'string' && record.rationale.trim().length > 0
    ? record.rationale.trim()
    : undefined
  return {
    outcome,
    ...riskLevel === undefined ? {} : { risk_level: riskLevel },
    ...userAuthorization === undefined ? {} : { user_authorization: userAuthorization },
    ...rationale === undefined ? {} : { rationale },
  }
}

/** Run one fresh, tool-less reviewer and dispose it after its structured result settles. */
export async function reviewEscalation(
  ctx: Context,
  config: ResolvedConfig,
  evidence: EscalationEvidence,
  requestSignal?: AbortSignal,
): Promise<ReviewerAssessment> {
  if (requestSignal?.aborted) {
    throw new ReviewerError('approval request was cancelled before review', 'cancelled')
  }

  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    deadline.abort(new Error('approval reviewer timed out'))
  }, config.timeoutMs)
  const signal = requestSignal === undefined
    ? deadline.signal
    : AbortSignal.any([requestSignal, deadline.signal])

  let run: SubagentRun | undefined
  let assessment: ReviewerAssessment | undefined
  let failure: unknown
  try {
    run = await reviewerStartParents.run(
      evidence.agent,
      () => ctx.subagents.start(config.subagentProvider, {
        label: 'approval review',
        parent: evidence.agent,
        signal,
        prompt: [{ type: 'text', text: buildReviewPrompt(evidence.agent.session.deriveMessages(), evidence) }],
        persona: buildReviewerPersona(config.policyPrompt),
        toolFilter: { allow: [] },
        outputSchema: REVIEW_OUTPUT_SCHEMA,
        agentOptions: {
          ...config.provider === undefined ? {} : { provider: config.provider },
          ...config.model === undefined ? {} : { model: config.model },
          maxTokens: config.maxOutputTokens,
        },
      }),
    )
    if (run.localAgent !== undefined) reviewerAgents.add(run.localAgent)
    const result = await run.result
    if (requestSignal?.aborted) {
      throw new ReviewerError('approval request was cancelled during review', 'cancelled')
    }
    if (timedOut) throw new ReviewerError('approval reviewer timed out', 'timeout')
    if (result.stopReason !== 'completed') {
      throw new ReviewerError(
        `approval reviewer ended with stop reason ${String(result.stopReason)}`,
        'unavailable',
      )
    }
    assessment = parseAssessment(result.structured)
  } catch (error: unknown) {
    if (error instanceof ReviewerError) failure = error
    else if (requestSignal?.aborted) {
      failure = new ReviewerError('approval request was cancelled during review', 'cancelled', { cause: error })
    } else if (timedOut) {
      failure = new ReviewerError('approval reviewer timed out', 'timeout', { cause: error })
    } else {
      failure = new ReviewerError('approval reviewer failed', 'unavailable', { cause: error })
    }
  } finally {
    clearTimeout(timer)
  }

  let disposalFailure: unknown
  if (run !== undefined) {
    try {
      await run.dispose()
    } catch (error: unknown) {
      disposalFailure = error
    }
  }

  // A deny remains authoritative even if cleanup reports a later fault. An
  // allow requires both a valid assessment and successful quiescent disposal.
  if (assessment?.outcome === 'deny') return assessment
  if (failure !== undefined) throw failure
  if (disposalFailure !== undefined) {
    throw new ReviewerError('approval reviewer could not be disposed cleanly', 'unavailable', {
      cause: disposalFailure,
    })
  }
  if (assessment === undefined) {
    throw new ReviewerError('approval reviewer returned no assessment', 'unavailable')
  }
  return assessment
}
