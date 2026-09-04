import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_SUBSCRIPTION_POLICY,
  GitHubCopilotDriver,
  OpenAICodexDriver,
  subscriptionProviders,
  type CodexAppServerPort,
  type RpcMessage,
} from '../src/subscription-drivers.ts'
import type { ModelHostProfile } from '../src/index.ts'

function profile(driver: string, provider: string, runtimeProfile: string): ModelHostProfile {
  return { version: 1, driver, provider, authMethod: 'subscription', model: 'test-model', reasoningEffort: 'high', runtimeProfile }
}

class FakeCodexServer implements CodexAppServerPort {
  listeners = new Set<(message: RpcMessage) => void>()
  responses: unknown[] = []
  calls: Array<{ method: string; params?: unknown }> = []
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  onMessage(listener: (message: RpcMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }) }
  emit(message: RpcMessage): void { for (const listener of this.listeners) listener(message) }
  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) })
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ id: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
    if (method === 'account/login/start') {
      setTimeout(() => this.emit({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } }), 0)
      return { loginId: 'login-1', verificationUrl: 'https://example.invalid/device', userCode: 'CODE-123' }
    }
    if (method === 'thread/start') return { thread: { id: 'thread-1' } }
    if (method === 'turn/start') {
      setTimeout(() => {
        this.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'thinking' } })
        this.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'working' } })
        this.emit({ id: 77, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'diagnose', arguments: { safe: true } } })
        this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
      }, 0)
      return { turn: { id: 'turn-1' } }
    }
    return {}
  }
}

describe('subscription runtime boundaries', () => {
  it('keeps Anthropic subscription unavailable until an explicit policy approval exists', () => {
    expect(ANTHROPIC_SUBSCRIPTION_POLICY.permitted).toBe(false)
    expect(subscriptionProviders({ MACHTIANI_ENABLE_ANTHROPIC_SUBSCRIPTION: '1' }).some(value => value.id === 'anthropic-claude')).toBe(false)
  })

  it('maps Codex app-server auth, models, streaming, tools, and interruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-codex-fake-'))
    const servers: FakeCodexServer[] = []
    const driver = new OpenAICodexDriver(profile('openai-codex-app-server', 'openai-codex', root), () => {
      const server = new FakeCodexServer(); servers.push(server); return server
    })
    expect(await driver.authenticated()).toBe(true)
    expect(await driver.models()).toEqual([{ id: 'gpt-test', name: 'GPT Test', reasoningEfforts: ['high'] }])
    const notices: unknown[] = []
    await driver.login({ prompt: async () => '', notify: event => notices.push(event) })
    expect(notices).toContainEqual({ type: 'device_code', userCode: 'CODE-123', verificationUri: 'https://example.invalid/device' })
    const events = []
    for await (const event of driver.generate({
      caller: 'installer', sessionId: 'test', messages: [{ role: 'user', content: 'inspect safely' }],
      tools: [{ name: 'diagnose', description: 'read-only diagnosis', parameters: { type: 'object' } }],
    })) events.push(event)
    expect(events).toContainEqual({ type: 'reasoning-delta', index: 1, text: 'thinking' })
    expect(events).toContainEqual({ type: 'text-delta', index: 0, text: 'working' })
    expect(events).toContainEqual({ type: 'tool-end', index: 2, id: 'call-1', name: 'diagnose', arguments: '{"safe":true}' })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
    const generation = servers.at(-1)!
    expect(generation.responses).toContainEqual({ id: 77, result: { contentItems: [{ type: 'inputText', text: 'The host will execute this tool call.' }], success: true } })
    expect(generation.calls.some(call => call.method === 'turn/interrupt')).toBe(true)
    const thread = generation.calls.find(call => call.method === 'thread/start')?.params as Record<string, unknown>
    expect(thread).toMatchObject({ sandbox: 'read-only', environments: [], runtimeWorkspaceRoots: [], ephemeral: true })
  })

  it('maps Copilot SDK output while exposing only caller-declared tools', async () => {
    const handlers = new Map<string, (event: any) => void>()
    let sessionConfig: any
    const fakeSession = {
      on: (name: string, handler: (event: any) => void) => { handlers.set(name, handler); return () => {} },
      sendAndWait: async () => {
        handlers.get('assistant.message_start')?.({ data: { messageId: 'm1' } })
        handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'considering' } })
        handlers.get('assistant.message_delta')?.({ data: { deltaContent: 'ready' } })
        await sessionConfig.tools[0].handler({ path: '/safe' }, { toolCallId: 'copilot-call-1' })
      },
      abort: async () => {}, disconnect: async () => {},
    }
    const fakeClient = {
      start: async () => {}, stop: async () => [], getAuthStatus: async () => ({ isAuthenticated: true }),
      listModels: async () => [{ id: 'copilot-test', name: 'Copilot Test', capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 1 } }, supportedReasoningEfforts: ['high'] }],
      createSession: async (config: any) => { sessionConfig = config; return fakeSession },
    }
    const driver = new GitHubCopilotDriver(profile('github-copilot-sdk', 'github-copilot', '/tmp/copilot-test'), () => fakeClient as never)
    expect(await driver.authenticated()).toBe(true)
    expect(await driver.models()).toEqual([{ id: 'copilot-test', name: 'Copilot Test', reasoningEfforts: ['high'] }])
    const events = []
    for await (const event of driver.generate({ caller: 'installer', sessionId: 'one', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object' } }] })) events.push(event)
    expect(sessionConfig.availableTools).toEqual(['inspect'])
    expect(sessionConfig.enableConfigDiscovery).toBe(false)
    expect(events.some(event => event.type === 'tool-end')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
  })
})
