import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_SUBSCRIPTION_POLICY,
  AnthropicClaudeDriver,
  claudeConversationInput,
  claudeConversationPrompt,
  ClaudeCliAuth,
  GitHubCopilotDriver,
  nativeConversationPrompt,
  OpenAICodexDriver,
  subscriptionProviders,
  type CodexAppServerPort,
  type RpcMessage,
} from '../src/subscription-drivers.ts'
import type { ModelHostGenerateRequest, ModelHostProfile } from '../src/index.ts'

function profile(driver: string, provider: string, runtimeProfile: string): ModelHostProfile {
  return { version: 1, driver, provider, authMethod: 'subscription', model: 'test-model', reasoningEffort: 'high', runtimeProfile }
}

function generation(messages: ModelHostGenerateRequest['messages']): ModelHostGenerateRequest {
  return { caller: 'machtiani', sessionId: 'stable-prefix', messages }
}

describe('provider-native conversation serialization', () => {
  it('keeps the complete previous prompt as an exact prefix when history is appended', () => {
    const initial = nativeConversationPrompt(generation([
      { role: 'system', content: 'Follow the project contract.', cacheControl: { type: 'ephemeral' } },
      { role: 'user', content: 'Inspect the repository.' },
    ]))
    const continued = nativeConversationPrompt(generation([
      { role: 'system', content: 'Follow the project contract.', cacheControl: { type: 'ephemeral' } },
      { role: 'user', content: 'Inspect the repository.' },
      { role: 'assistant', content: 'The inspection is complete.' },
      { role: 'user', content: 'Now summarize it.' },
    ]))

    expect(continued.text.startsWith(initial.text)).toBe(true)
    expect(continued.cacheBoundary).toBe(initial.cacheBoundary)
    expect(initial.text).not.toContain('cacheControl')
    expect(initial.text.slice(0, initial.cacheBoundary)).toContain('Follow the project contract.')
  })

  it('maps a neutral cache boundary to Claude native system-prefix caching', () => {
    const request = generation([
      { role: 'system', content: 'Stable instructions.', cacheControl: { type: 'ephemeral' } },
      { role: 'user', content: 'Variable suffix.' },
    ])
    const input = claudeConversationInput(request)
    const serialized = nativeConversationPrompt(request)

    expect(input.systemPrompt).toEqual({
      type: 'custom',
      prompt: [
        'You are the Machtiani installation assistant.',
        serialized.text.slice(0, serialized.cacheBoundary),
      ],
      snapshot: true,
    })
    expect(input.prompt).toBe(serialized.text.slice(serialized.cacheBoundary))
    expect(JSON.stringify(input)).not.toContain('cache_control')
  })
})

class FakeCodexServer implements CodexAppServerPort {
  listeners = new Set<(message: RpcMessage) => void>()
  responses: unknown[] = []
  calls: Array<{ method: string; params?: unknown }> = []
  constructor(private readonly transportFailure = false) {}
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
      return (params as { type?: string } | undefined)?.type === 'chatgptDeviceCode'
        ? { loginId: 'login-1', verificationUrl: 'https://example.invalid/device', userCode: 'CODE-123' }
        : { loginId: 'login-1', authUrl: 'https://example.invalid/browser' }
    }
    if (method === 'thread/start') return { thread: { id: 'thread-1' } }
    if (method === 'turn/start') {
      setTimeout(() => {
        if (this.transportFailure) {
          this.emit({ method: 'transport/error', params: {} })
          return
        }
        this.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'thinking' } })
        this.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'working' } })
        this.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 8, reasoningOutputTokens: 2 } } } })
        this.emit({ id: 77, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'diagnose', arguments: { safe: true } } })
        this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
      }, 0)
      return { turn: { id: 'turn-1' } }
    }
    return {}
  }
}

class SynchronousCodexServer extends FakeCodexServer {
  override async call(method: string, params?: unknown): Promise<unknown> {
    if (method !== 'turn/start') return await super.call(method, params)
    this.calls.push({ method, ...(params === undefined ? {} : { params }) })
    this.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-fast', delta: 'READY' } })
    this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-fast' } } })
    return { turn: { id: 'turn-fast' } }
  }
}

describe('subscription runtime boundaries', () => {
  it('continues Claude tool results without tag-shaped transcript markup', () => {
    const prompt = claudeConversationPrompt({
      caller: 'installer',
      sessionId: 'installer-one',
      messages: [
        { role: 'user', content: 'Please begin.' },
        {
          role: 'assistant', content: 'I will inspect the next stage.',
          toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"file_path":"02-provider.md"}' }],
        },
        { role: 'tool', content: 'Stage instructions loaded.', toolCallId: 'call-1', toolName: 'read' },
      ],
    })
    expect(prompt).toContain('"requestedTools":[{"id":"call-1","name":"read"')
    expect(prompt).toContain('"toolResultFor":{"id":"call-1","name":"read"}')
    expect(prompt).toContain('A completed tool result is not a user-facing stopping point.')
    expect(prompt).not.toContain('[tool call')
    expect(prompt).not.toContain('<tool [')
    expect(prompt).not.toContain('</invoke>')
  })

  it('offers the reviewed Claude Pro/Max Agent SDK route unless explicitly disabled', () => {
    expect(ANTHROPIC_SUBSCRIPTION_POLICY.permitted).toBe(true)
    expect(ANTHROPIC_SUBSCRIPTION_POLICY.reviewedAgentSdkVersion).toBe('0.3.260')
    expect(ANTHROPIC_SUBSCRIPTION_POLICY.reviewedClaudeCodeVersion).toBe('2.1.260')
    expect(subscriptionProviders({}).some(value => value.id === 'anthropic-claude')).toBe(true)
    expect(subscriptionProviders({ MACHTIANI_DISABLE_ANTHROPIC_CLAUDE: '1' }).some(value => value.id === 'anthropic-claude')).toBe(false)
  })

  it('maps Claude Code browser authentication without echoing its authorization code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-claude-login-'))
    const invocations: string[][] = []
    const written: string[] = []
    const factory = (_profile: string, args: readonly string[]) => {
      invocations.push([...args])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      stdin.on('data', chunk => { written.push(chunk.toString('utf8')) })
      const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => true })
      queueMicrotask(() => {
        if (args[1] === 'login') {
          stdout.write('Opening browser to sign in…\nIf the browser did not open, visit: https://claude.example/authorize?state=one\nPaste code here if prompted >')
          stdin.once('data', () => queueMicrotask(() => child.emit('exit', 0)))
        } else {
          stdout.write('{"loggedIn":true,"authMethod":"claude.ai"}\n')
          child.emit('exit', 0)
        }
      })
      return child as never
    }
    const notices: unknown[] = []
    try {
      await new ClaudeCliAuth(factory).login(root, {
        prompt: async prompt => {
          expect(prompt.type).toBe('manual_code')
          return 'private-authorization-code'
        },
        notify: event => notices.push(event),
      })
      expect(invocations).toEqual([
        ['auth', 'login', '--claudeai'],
        ['auth', 'status', '--json'],
      ])
      expect(written).toContain('private-authorization-code\n')
      expect(JSON.stringify(notices)).not.toContain('private-authorization-code')
      expect(notices).toContainEqual({
        type: 'auth_url',
        url: 'https://claude.example/authorize?state=one',
        instructions: 'Open this page in your browser, sign in to Claude, then return here and paste the authorization code.',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('interrupts Claude Code sign-in and reports cancellation distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-claude-login-cancel-'))
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr, stdin,
      kill: (signal: NodeJS.Signals) => {
        expect(signal).toBe('SIGINT')
        queueMicrotask(() => child.emit('exit', 130))
        return true
      },
    })
    const controller = new AbortController()
    try {
      const login = new ClaudeCliAuth(() => child as never).login(root, {
        signal: controller.signal,
        prompt: async () => '',
        notify: () => {},
      })
      queueMicrotask(() => controller.abort())
      await expect(login).rejects.toMatchObject({ code: 'CANCELLED', message: 'Claude sign-in was cancelled.' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps Claude models, reasoning, streaming tools, usage, and isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-claude-fake-'))
    const calls: Array<{ prompt: unknown; options?: Record<string, any> }> = []
    const factory = (parameters: { prompt: unknown; options?: Record<string, any> }) => {
      calls.push(parameters)
      const messages = typeof parameters.prompt === 'string' ? [
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering' } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'checking' } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 1 } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'claude-call-1', name: 'mcp__machtiani__diagnose', input: {} } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"safe":true}' } } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 2 } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
        { type: 'result', subtype: 'success', is_error: false, result: '', errors: [], usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 } },
      ] : []
      return {
        async * [Symbol.asyncIterator]() { for (const message of messages) yield message },
        supportedModels: async () => [{ value: 'claude-test', displayName: 'Claude Test', description: 'Test', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
        close: () => {},
      } as never
    }
    const driver = new AnthropicClaudeDriver(
      profile('anthropic-claude-agent-sdk', 'anthropic-claude', root),
      factory as never,
      { authenticated: async () => true, login: async () => {}, logout: async () => {} },
    )
    try {
      expect(await driver.authenticated()).toBe(true)
      expect(await driver.models()).toEqual([{ id: 'claude-test', name: 'Claude Test', reasoningEfforts: ['low', 'high'] }])
      const events = []
      for await (const event of driver.generate({
        caller: 'installer', sessionId: 'claude-one', messages: [{ role: 'user', content: 'inspect safely', cacheControl: { type: 'ephemeral' } }],
        tools: [{
          name: 'diagnose', description: 'read-only diagnosis',
          parameters: { type: 'object', additionalProperties: false, properties: { safe: { type: 'boolean' } }, required: ['safe'] },
        }],
      })) events.push(event)
      expect(events).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'considering' })
      expect(events).toContainEqual({ type: 'text-delta', index: 1, text: 'checking' })
      expect(events).toContainEqual({ type: 'tool-end', index: 2, id: 'claude-call-1', name: 'diagnose', arguments: '{"safe":true}' })
      expect(events).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 3 })
      expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
      const generation = calls.at(-1)!.options!
      expect(generation).toMatchObject({
        settingSources: [], plugins: [], persistSession: false, strictMcpConfig: true,
        tools: [], allowedTools: ['mcp__machtiani__diagnose'], permissionMode: 'bypassPermissions',
        systemPrompt: { type: 'custom', prompt: ['You are the Machtiani installation assistant.', expect.any(String)], snapshot: true },
      })
      expect(calls.at(-1)?.prompt).toBe('Continue immediately from the canonical conversation above.')
      expect(JSON.stringify({ prompt: calls.at(-1)?.prompt, systemPrompt: generation.systemPrompt })).not.toContain('cache_control')
      expect(generation.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(generation.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(generation.env.CLAUDE_CONFIG_DIR).toBe(root)
      const firstWorkspace = generation.cwd
      const restartedEvents = []
      for await (const event of driver.generate({
        caller: 'machtiani', sessionId: 'claude-two', messages: [{ role: 'user', content: 'inspect again' }],
        tools: [{ name: 'diagnose', description: 'read-only diagnosis', parameters: { type: 'object', properties: { safe: { type: 'boolean' } } } }],
      })) restartedEvents.push(event)
      expect(restartedEvents).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 3 })
      expect(calls.at(-1)?.options?.cwd).not.toBe(firstWorkspace)
      expect(calls.at(-1)?.options?.persistSession).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps both Codex app-server sign-in modes, models, streaming, tools, and interruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-codex-fake-'))
    const servers: FakeCodexServer[] = []
    const driver = new OpenAICodexDriver(profile('openai-codex-app-server', 'openai-codex', root), () => {
      const server = new FakeCodexServer(); servers.push(server); return server
    })
    expect(await driver.authenticated()).toBe(true)
    expect(await driver.models()).toEqual([{ id: 'gpt-test', name: 'GPT Test', reasoningEfforts: ['high'] }])
    const browserNotices: unknown[] = []
    await driver.login({ prompt: async () => '', notify: event => browserNotices.push(event) }, 'browser')
    expect(servers.at(-1)?.calls).toContainEqual({
      method: 'account/login/start',
      params: { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' },
    })
    expect(browserNotices).toContainEqual({
      type: 'auth_url',
      url: 'https://example.invalid/browser',
      instructions: 'Open this page in your browser and sign in with ChatGPT. The installer will continue when sign-in finishes.',
      waitForCompletion: true,
    })
    const deviceNotices: unknown[] = []
    await driver.login({ prompt: async () => '', notify: event => deviceNotices.push(event) }, 'device_code')
    expect(servers.at(-1)?.calls).toContainEqual({ method: 'account/login/start', params: { type: 'chatgptDeviceCode' } })
    expect(deviceNotices).toContainEqual({ type: 'device_code', userCode: 'CODE-123', verificationUri: 'https://example.invalid/device' })
    const events = []
    for await (const event of driver.generate({
      caller: 'installer', sessionId: 'test', messages: [{ role: 'user', content: 'inspect safely' }],
      tools: [{ name: 'diagnose', description: 'read-only diagnosis', parameters: { type: 'object' } }],
    })) events.push(event)
    expect(events).toContainEqual({ type: 'reasoning-delta', index: 1, text: 'thinking' })
    expect(events).toContainEqual({ type: 'text-delta', index: 0, text: 'working' })
    expect(events).toContainEqual({ type: 'tool-end', index: 2, id: 'call-1', name: 'diagnose', arguments: '{"safe":true}' })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 8, reasoningTokens: 2 })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
    const generation = servers.at(-1)!
    expect(generation.responses).toContainEqual({ id: 77, result: { contentItems: [{ type: 'inputText', text: 'The host will execute this tool call.' }], success: true } })
    expect(generation.calls.some(call => call.method === 'turn/interrupt')).toBe(true)
    const thread = generation.calls.find(call => call.method === 'thread/start')?.params as Record<string, unknown>
    expect(thread).toMatchObject({ sandbox: 'read-only', environments: [], runtimeWorkspaceRoots: [], ephemeral: true })
    const firstWorkspace = thread.cwd
    const restartedEvents = []
    for await (const event of driver.generate({
      caller: 'machtiani', sessionId: 'test-two', messages: [{ role: 'user', content: 'inspect again' }],
      tools: [{ name: 'diagnose', description: 'read-only diagnosis', parameters: { type: 'object' } }],
    })) restartedEvents.push(event)
    expect(restartedEvents).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 8, reasoningTokens: 2 })
    const restartedThread = servers.at(-1)?.calls.find(call => call.method === 'thread/start')?.params as Record<string, unknown>
    expect(restartedThread.cwd).not.toBe(firstWorkspace)
    expect(restartedThread).toMatchObject({ ephemeral: true, environments: [], runtimeWorkspaceRoots: [] })
  })

  it('starts the official Codex app-server from a new private runtime profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-codex-profile-'))
    const runtimeProfile = join(root, 'not-created-yet')
    try {
      const driver = new OpenAICodexDriver(profile('openai-codex-app-server', 'openai-codex', runtimeProfile))
      await expect(driver.authenticated()).resolves.toBe(false)
      const metadata = await lstat(runtimeProfile)
      expect(metadata.isDirectory()).toBe(true)
      expect(metadata.mode & 0o777).toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports pinned Codex transport drift distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-codex-drift-'))
    const driver = new OpenAICodexDriver(
      profile('openai-codex-app-server', 'openai-codex', root),
      () => new FakeCodexServer(true),
    )
    const consume = async () => {
      for await (const _event of driver.generate(generation([{ role: 'user', content: 'hello' }]))) {
        // Transport drift produces no model event.
      }
    }
    try {
      await expect(consume()).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not lose a fast Codex response emitted before turn/start returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-codex-fast-turn-'))
    const driver = new OpenAICodexDriver(
      profile('openai-codex-app-server', 'openai-codex', root),
      () => new SynchronousCodexServer(),
    )
    const events = []
    try {
      for await (const event of driver.generate(generation([{ role: 'user', content: 'Reply READY.' }]))) events.push(event)
      expect(events).toContainEqual({ type: 'text-delta', index: 0, text: 'READY' })
      expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports expired Claude subscription authentication distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-claude-expired-'))
    const driver = new AnthropicClaudeDriver(
      profile('anthropic-claude-agent-sdk', 'anthropic-claude', root),
      () => ({
        async * [Symbol.asyncIterator]() { throw new Error('OAuth token expired') },
        close: () => {},
      }) as never,
      { authenticated: async () => true, login: async () => {}, logout: async () => {} },
    )
    const consume = async () => {
      for await (const _event of driver.generate(generation([{ role: 'user', content: 'hello' }]))) {
        // Authentication failure produces no model event.
      }
    }
    try {
      await expect(consume()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('maps the official Copilot CLI login lifecycle without requiring an account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-copilot-login-'))
    try {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true })
      const notices: unknown[] = []
      const driver = new GitHubCopilotDriver(
        profile('github-copilot-sdk', 'github-copilot', root),
        () => { throw new Error('the SDK client is not needed for login') },
        () => {
          queueMicrotask(() => {
            stdout.write('Open GitHub and enter the displayed device code.\n')
            child.emit('exit', 0)
          })
          return child as never
        },
      )
      await expect(driver.login({ prompt: async () => '', notify: event => notices.push(event) })).resolves.toBeUndefined()
      expect(notices).toEqual([
        { type: 'progress', message: 'Starting GitHub device sign-in' },
        { type: 'info', message: 'Open GitHub and enter the displayed device code.' },
      ])
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('interrupts Copilot CLI login and reports cancellation distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-copilot-login-cancel-'))
    try {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: (signal: NodeJS.Signals) => {
          expect(signal).toBe('SIGINT')
          queueMicrotask(() => child.emit('exit', 130))
          return true
        },
      })
      const controller = new AbortController()
      const driver = new GitHubCopilotDriver(
        profile('github-copilot-sdk', 'github-copilot', root),
        () => { throw new Error('the SDK client is not needed for login') },
        () => child as never,
      )
      const login = driver.login({ signal: controller.signal, prompt: async () => '', notify: () => {} })
      queueMicrotask(() => controller.abort())
      await expect(login).rejects.toMatchObject({ code: 'CANCELLED', message: 'GitHub Copilot sign-in was cancelled.' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
