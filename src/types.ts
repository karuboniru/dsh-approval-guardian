import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** Behavior when the automated reviewer cannot produce a valid decision. */
export type FailureMode = 'fail-closed' | 'fallback-to-user'

/** Structured decision returned by the approval reviewer. */
export interface ReviewerAssessment {
  readonly outcome: 'allow' | 'deny'
  readonly risk_level?: 'low' | 'medium' | 'high' | 'critical'
  readonly user_authorization?: 'unknown' | 'low' | 'medium' | 'high'
  readonly rationale?: string
}

/** Exact escalation evidence supplied to one fresh reviewer. */
export interface EscalationEvidence {
  readonly agent: Agent
  readonly tool: string
  readonly callId: string
  readonly arguments: Record<string, unknown>
  readonly cwd: string
  readonly workspaceRoot: string
  readonly currentMode: SandboxMode
  readonly requestedMode: SandboxMode
  readonly justification: string
  readonly approvalReason: string
  readonly sessionId: string
}

/** Fully defaulted runtime configuration. */
export interface ResolvedConfig {
  readonly policyPrompt: string
  readonly provider?: string
  readonly model?: string
  readonly subagentProvider: string
  readonly failureMode: FailureMode
  readonly timeoutMs: number
  readonly maxOutputTokens: number
}
