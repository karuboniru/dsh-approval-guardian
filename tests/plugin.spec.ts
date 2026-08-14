import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, resolveConfig, type Config } from '../src/index.ts'

type Listener = (...args: any[]) => any

interface FakeAgent {
  readonly id: string
  readonly options: { provider: string; model: string }
  readonly session: {
    readonly id: string
    readonly header: { cwd: string }
    deriveMessages(): any[]
  }
}

interface FakeRunResult {
  readonly output: any[]
  readonly structured?: unknown
  readonly stopReason: string
}

interface FakeSubagentRequest {
  readonly parent: FakeAgent
  readonly prompt: Array<{ type: string; text: string }>
  readonly signal: AbortSignal
  readonly toolFilter: { allow: string[] }
  readonly agentOptions: Record<string, unknown>
  readonly persona: string
}

function agent(messages: any[] = []): FakeAgent {
  return {
    id: 'agent-1',
    options: { provider: 'parent-provider', model: 'parent-model' },
    session: {
      id: 'session-1',
      header: { cwd: '/workspace' },
      deriveMessages: () => messages,
    },
  }
}

function completed(structured: unknown): FakeRunResult {
  return { output: [], structured, stopReason: 'completed' }
}

function setup(
  config: Config = {},
  start: (provider: string, request: FakeSubagentRequest) => Promise<any> = async () => ({
    id: 'review-1',
    localAgent: undefined,
    result: Promise.resolve(completed({ outcome: 'allow' })),
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
) {
  const listeners = new Map<string, Listener>()
  const effects: Array<() => unknown> = []
  const fake = {
    sandboxPolicy: {
      resolve: vi.fn(() => ({ mode: 'workspace-write', workspaceRoot: '/workspace' })),
    },
    subagents: { start: vi.fn(start) },
    effect: vi.fn((register: () => () => unknown) => {
      const dispose = register()
      effects.push(dispose)
      return dispose
    }),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener)
      return () => true
    }),
  }
  apply(fake as unknown as Context, config)
  return { fake, listeners, effects }
}

function execution(owner: FakeAgent, overrides: Record<string, unknown> = {}) {
  const deferred: any[] = []
  return {
    agent: owner,
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'bash',
    arguments: {
      command: 'touch /outside/file',
      sandbox_permissions: 'danger-full-access',
      justification: 'write the requested output outside the workspace',
    },
    signal: new AbortController().signal,
    deferContext: (message: any) => deferred.push(message),
    deferred,
    ...overrides,
  }
}

function request(owner: FakeAgent, overrides: Record<string, unknown> = {}) {
  return {
    agent: owner,
    callId: 'call-1',
    toolName: 'bash',
    reason: 'escalate sandbox to danger-full-access: write the requested output outside the workspace',
    ...overrides,
  }
}

async function invoke(
  listeners: Map<string, Listener>,
  exec: ReturnType<typeof execution>,
  approvalRequest: ReturnType<typeof request>,
  downstream: () => Promise<string> = () => Promise.resolve('unavailable'),
): Promise<string> {
  const tool = listeners.get('tools/execute')!
  const approval = listeners.get('approval/request')!
  return tool(exec, () => approval(approvalRequest, downstream))
}

describe('approval guardian interception', () => {
  it('leaves an ordinary workspace execution completely untouched', async () => {
    const { fake, listeners } = setup()
    const owner = agent()
    const exec = execution(owner, { arguments: { command: 'touch local.txt' } })
    const tool = listeners.get('tools/execute')!

    await expect(tool(exec, () => Promise.resolve('body-result'))).resolves.toBe('body-result')
    expect(fake.subagents.start).not.toHaveBeenCalled()
    expect(exec.deferred).toEqual([])
    expect(listeners.has('tools/pre-execute')).toBe(false)
  })

  it('does not inspect a sandbox failure when no escalation approval was requested', async () => {
    const { fake, listeners } = setup()
    const owner = agent()
    const exec = execution(owner, { arguments: { command: 'touch /outside/file' } })
    const tool = listeners.get('tools/execute')!
    const failed = { isError: true, content: [{ type: 'text', text: 'sandbox denied' }] }

    await expect(tool(exec, () => Promise.resolve(failed))).resolves.toBe(failed)
    expect(fake.subagents.start).not.toHaveBeenCalled()
    expect(exec.deferred).toEqual([])
  })

  it.each([
    ['ordinary approval', { arguments: { command: 'echo ok' } }, {}],
    ['different call', {}, { callId: 'other-call' }],
    ['different tool', {}, { toolName: 'fs' }],
    ['different reason', {}, { reason: 'approve something else' }],
  ])('delegates an unrelated %s', async (_label, execOverrides, requestOverrides) => {
    const { fake, listeners } = setup()
    const owner = agent()
    const downstream = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await invoke(
      listeners,
      execution(owner, execOverrides),
      request(owner, requestOverrides),
      downstream,
    )

    expect(outcome).toBe('allowed-once')
    expect(downstream).toHaveBeenCalledOnce()
    expect(fake.subagents.start).not.toHaveBeenCalled()
  })

  it('delegates a non-widening sandbox request', async () => {
    const { fake, listeners } = setup()
    const owner = agent()
    const downstream = vi.fn().mockResolvedValue('rejected')
    const exec = execution(owner, {
      arguments: {
        command: 'echo ok',
        sandbox_permissions: 'workspace-write',
        justification: 'same mode',
      },
    })
    const outcome = await invoke(listeners, exec, request(owner, {
      reason: 'escalate sandbox to workspace-write: same mode',
    }), downstream)

    expect(outcome).toBe('rejected')
    expect(downstream).toHaveBeenCalledOnce()
    expect(fake.subagents.start).not.toHaveBeenCalled()
  })

  it('allows a strict escalation with inherited provider/model and no reviewer tools', async () => {
    let captured: FakeSubagentRequest | undefined
    const dispose = vi.fn().mockResolvedValue(undefined)
    const { fake, listeners } = setup({}, async (_provider, reviewRequest) => {
      captured = reviewRequest
      return {
        id: 'review-1',
        localAgent: undefined,
        result: Promise.resolve(completed({
          outcome: 'allow',
          risk_level: 'low',
          rationale: 'The operation is narrow.',
        })),
        dispose,
      }
    })
    const owner = agent()
    const exec = execution(owner)

    await expect(invoke(listeners, exec, request(owner))).resolves.toBe('allowed-once')
    expect(fake.subagents.start).toHaveBeenCalledOnce()
    expect(captured?.toolFilter).toEqual({ allow: [] })
    expect(captured?.agentOptions).toEqual({ maxTokens: 1_024 })
    expect(captured?.prompt[0]?.text).toContain('"callId": "call-1"')
    expect(captured?.persona).toContain('# Mandatory evidence handling')
    expect(captured?.persona).toContain('# Mandatory reviewer-session separation')
    expect(dispose).toHaveBeenCalledOnce()
    expect(exec.deferred).toHaveLength(1)
    expect(exec.deferred[0].content[0].text).toContain('UNTRUSTED REVIEWER OUTPUT START')
  })

  it('structurally removes delegated-child runtime contexts from reviewer assembly', async () => {
    let mounted: ReturnType<typeof setup> | undefined
    let reviewerAssembly: any
    mounted = setup({}, async (_provider, req) => {
      const assembly = {
        sections: [{ name: 'deployment:persona', text: req.persona }],
        contexts: [
          { name: 'approval:policy', text: 'Approval prompts are disabled in this session.' },
          { name: 'subagent:delegation', text: 'Your delegated permission scope cannot be widened.' },
        ],
        tools: [],
        variables: {},
      }
      const child = {
        id: 'review-child',
        options: { provider: 'p', model: 'm' },
        session: {
          id: 'review-child',
          header: { cwd: '/workspace', parentSession: req.parent.session.id },
          deriveMessages: () => [],
        },
      }
      reviewerAssembly = await mounted!.listeners.get('system-prompt/assemble')!(
        assembly,
        { agent: child },
        () => Promise.resolve(assembly),
      )
      return {
        id: 'review-child', localAgent: child,
        result: Promise.resolve(completed({ outcome: 'allow' })),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    const owner = agent()

    await expect(invoke(mounted.listeners, execution(owner), request(owner))).resolves.toBe('allowed-once')
    expect(reviewerAssembly.contexts).toEqual([])

    const ordinary = {
      sections: [], contexts: [{ name: 'ordinary', text: 'keep me' }], tools: [], variables: {},
    }
    const ordinaryAssembly = await mounted.listeners.get('system-prompt/assemble')!(
      ordinary,
      { agent: owner },
      () => Promise.resolve(ordinary),
    )
    expect(ordinaryAssembly.contexts).toEqual(ordinary.contexts)
  })

  it('passes the configured reviewer provider and model as a pair', async () => {
    let captured: FakeSubagentRequest | undefined
    const { listeners } = setup({ provider: 'review-provider', model: 'review-model' }, async (_provider, req) => {
      captured = req
      return {
        id: 'review-1', localAgent: undefined,
        result: Promise.resolve(completed({ outcome: 'allow' })),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    const owner = agent()

    await invoke(listeners, execution(owner), request(owner))
    expect(captured?.agentOptions).toEqual({
      provider: 'review-provider', model: 'review-model', maxTokens: 1_024,
    })
  })

  it('never falls back after an explicit reviewer denial', async () => {
    const downstream = vi.fn().mockResolvedValue('allowed-once')
    const { listeners } = setup({ failureMode: 'fallback-to-user' }, async () => ({
      id: 'review-1', localAgent: undefined,
      result: Promise.resolve(completed({ outcome: 'deny', risk_level: 'high' })),
      dispose: vi.fn().mockRejectedValue(new Error('late cleanup fault')),
    }))
    const owner = agent()

    await expect(invoke(listeners, execution(owner), request(owner), downstream)).resolves.toBe('rejected')
    expect(downstream).not.toHaveBeenCalled()
  })

  it('fails closed when structured reviewer output is invalid', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const { listeners } = setup({}, async () => ({
      id: 'review-1', localAgent: undefined,
      result: Promise.resolve(completed({ rationale: 'missing outcome' })),
      dispose,
    }))
    const owner = agent()
    const exec = execution(owner)

    await expect(invoke(listeners, exec, request(owner))).resolves.toBe('unavailable')
    expect(dispose).toHaveBeenCalledOnce()
    expect(exec.deferred[0].content[0].text).toContain('fail-closed')
  })

  it('uses the downstream answerer only in fallback-to-user mode', async () => {
    const downstream = vi.fn().mockResolvedValue('allowed-once')
    const { listeners } = setup({ failureMode: 'fallback-to-user' }, async () => {
      throw new Error('provider unavailable')
    })
    const owner = agent()
    const exec = execution(owner)

    await expect(invoke(listeners, exec, request(owner), downstream)).resolves.toBe('allowed-once')
    expect(downstream).toHaveBeenCalledOnce()
    expect(exec.deferred[0].content[0].text).toContain('downstream approval channel returned allowed-once')
  })

  it('returns cancelled without consulting a reviewer or human after request cancellation', async () => {
    const downstream = vi.fn().mockResolvedValue('allowed-once')
    const { fake, listeners } = setup({ failureMode: 'fallback-to-user' })
    const owner = agent()
    const controller = new AbortController()
    controller.abort()

    await expect(invoke(
      listeners,
      execution(owner),
      request(owner, { signal: controller.signal }),
      downstream,
    )).resolves.toBe('cancelled')
    expect(fake.subagents.start).not.toHaveBeenCalled()
    expect(downstream).not.toHaveBeenCalled()
  })

  it('treats a reviewer deadline as unavailable and aborts the child', async () => {
    let childSignal: AbortSignal | undefined
    const { listeners } = setup({ timeoutMs: 5 }, async (_provider, req) => {
      childSignal = req.signal
      return {
        id: 'review-1', localAgent: undefined,
        result: new Promise<FakeRunResult>((resolve) => {
          req.signal.addEventListener('abort', () => {
            resolve({ output: [], stopReason: 'aborted' })
          }, { once: true })
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    const owner = agent()

    await expect(invoke(listeners, execution(owner), request(owner))).resolves.toBe('unavailable')
    expect(childSignal?.aborted).toBe(true)
  })

  it('isolates parallel tool executions by async context', async () => {
    const pending = new Map<string, (result: FakeRunResult) => void>()
    const { listeners } = setup({}, async (_provider, req) => {
      const text = req.prompt[0]?.text ?? ''
      const callId = text.includes('"callId": "call-a"') ? 'call-a' : 'call-b'
      return {
        id: `review-${callId}`,
        localAgent: undefined,
        result: new Promise<FakeRunResult>((resolve) => pending.set(callId, resolve)),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    const owner = agent()
    const execA = execution(owner, { callId: 'call-a' })
    const execB = execution(owner, { callId: 'call-b' })
    const first = invoke(listeners, execA, request(owner, { callId: 'call-a' }))
    const second = invoke(listeners, execB, request(owner, { callId: 'call-b' }))

    await vi.waitFor(() => expect(pending.size).toBe(2))
    pending.get('call-b')?.(completed({ outcome: 'allow' }))
    pending.get('call-a')?.(completed({ outcome: 'deny' }))
    await expect(first).resolves.toBe('rejected')
    await expect(second).resolves.toBe('allowed-once')
    expect(execA.deferred[0].content[0].text).toContain('"outcome": "deny"')
    expect(execB.deferred[0].content[0].text).toContain('"outcome": "allow"')
  })

  it('uses the nested Code Mode execution identity for a nested escalation', async () => {
    const prompts: string[] = []
    const { listeners } = setup({}, async (_provider, req) => {
      prompts.push(req.prompt[0]?.text ?? '')
      return {
        id: 'review-inner', localAgent: undefined,
        result: Promise.resolve(completed({ outcome: 'allow' })),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    const owner = agent()
    const tool = listeners.get('tools/execute')!
    const approval = listeners.get('approval/request')!
    const outer = execution(owner, {
      callId: 'outer', name: 'run_code', arguments: { code: 'tools.bash(...)' },
    })
    const inner = execution(owner, { callId: 'inner' })

    const outcome = await tool(outer, () => tool(inner, () => approval(
      request(owner, { callId: 'inner' }),
      () => Promise.resolve('unavailable'),
    )))
    expect(outcome).toBe('allowed-once')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('"callId": "inner"')
    expect(inner.deferred).toHaveLength(1)
    expect(outer.deferred).toEqual([])
  })
})

describe('configuration', () => {
  it('requires provider and model together', () => {
    expect(() => resolveConfig({ provider: 'only-provider' })).toThrow(/configured together/)
    expect(() => resolveConfig({ model: 'only-model' })).toThrow(/configured together/)
  })

  it('keeps fixed reviewer rules around a configured policy replacement', () => {
    const resolved = resolveConfig({ prompt: 'DENY writes to /protected.' })
    expect(resolved.policyPrompt).toBe('DENY writes to /protected.')
  })
})
