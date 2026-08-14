import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as guardian from '../src/index.ts'

class ToolsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
}

class ApprovalStub extends Service {
  constructor(ctx: Context) { super(ctx, 'approval') }
}

class SandboxPolicyStub extends Service {
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }

  resolve() {
    return { mode: 'workspace-write' as const, workspaceRoot: '/workspace' }
  }
}

class SystemPromptStub extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
}

class SubagentsStub extends Service {
  readonly start = vi.fn(async () => ({
    id: 'review',
    localAgent: undefined,
    result: Promise.resolve({ output: [], structured: { outcome: 'allow' }, stopReason: 'completed' }),
    dispose: vi.fn().mockResolvedValue(undefined),
  }))

  constructor(ctx: Context) { super(ctx, 'subagents') }
}

function owner() {
  return {
    id: 'agent',
    options: { provider: 'p', model: 'm' },
    session: {
      id: 'session',
      header: { cwd: '/workspace' },
      deriveMessages: () => [],
    },
  }
}

async function composedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ToolsStub)
  await ctx.plugin(ApprovalStub)
  await ctx.plugin(SandboxPolicyStub)
  await ctx.plugin(SystemPromptStub)
  await ctx.plugin(SubagentsStub)
  return ctx
}

describe('real Cordis plugin lifecycle', () => {
  it('has function-plugin exports and removes both listeners on fiber disposal', async () => {
    expect('default' in guardian).toBe(false)
    expect(guardian.name).toBe('approval-guardian')
    expect(guardian.inject).toEqual(['tools', 'approval', 'subagents', 'sandboxPolicy', 'systemPrompt'])

    const ctx = await composedContext()
    const fiber = await ctx.plugin(guardian, { timeoutMs: 5_000 })
    const agent = owner()
    const deferred: unknown[] = []
    const exec = {
      agent,
      callId: 'call',
      rootCallId: 'call',
      name: 'bash',
      arguments: {
        command: 'touch /outside/file',
        sandbox_permissions: 'danger-full-access',
        justification: 'write requested output',
      },
      signal: new AbortController().signal,
      deferContext: (message: unknown) => deferred.push(message),
    }
    const ask = () => ctx.waterfall('approval/request', {
      agent,
      callId: 'call',
      toolName: 'bash',
      reason: 'escalate sandbox to danger-full-access: write requested output',
    } as any, () => Promise.resolve('unavailable'))

    await expect(ctx.waterfall('tools/execute', exec as any, ask as any)).resolves.toBe('allowed-once')
    expect(deferred).toHaveLength(1)

    await fiber.dispose()
    await expect(ctx.waterfall('tools/execute', exec as any, ask as any)).resolves.toBe('unavailable')
    expect(deferred).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('cancels and drains an active reviewer before plugin disposal completes', async () => {
    const ctx = await composedContext()
    const entered = Promise.withResolvers<void>()
    const disposed = Promise.withResolvers<void>()
    ;(ctx.subagents as any).start = vi.fn(async (_provider: string, req: { signal: AbortSignal }) => {
      entered.resolve()
      return {
        id: 'review',
        localAgent: undefined,
        result: new Promise((resolve) => {
          req.signal.addEventListener('abort', () => {
            resolve({ output: [], stopReason: 'aborted' })
          }, { once: true })
        }),
        async dispose() { disposed.resolve() },
      }
    })
    const fiber = await ctx.plugin(guardian, { timeoutMs: 60_000 })
    const agent = owner()
    const exec = {
      agent,
      callId: 'call',
      rootCallId: 'call',
      name: 'bash',
      arguments: {
        command: 'touch /outside/file',
        sandbox_permissions: 'danger-full-access',
        justification: 'write requested output',
      },
      signal: new AbortController().signal,
      deferContext() {},
    }
    const pending = ctx.waterfall('tools/execute', exec as any, () => ctx.waterfall(
      'approval/request',
      {
        agent,
        callId: 'call',
        toolName: 'bash',
        reason: 'escalate sandbox to danger-full-access: write requested output',
      } as any,
      () => Promise.resolve('unavailable'),
    ) as any)
    await entered.promise

    await fiber.dispose()
    await disposed.promise
    await expect(pending).resolves.toBe('cancelled')
    await ctx.fiber.dispose()
  })
})
