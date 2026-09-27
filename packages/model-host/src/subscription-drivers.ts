import { protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import {
  AbortError as ClaudeAbortError,
  createSdkMcpServer,
  query as claudeQuery,
  tool as claudeTool,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKMessage as ClaudeMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { CopilotClient, type CopilotSession, type Tool } from '@github/copilot-sdk'
import * as z from 'zod/v4'
import type {
  ModelHostAuthInteraction,
  ModelHostEvent,
  ModelHostGenerateRequest,
  ModelHostLoginMode,
  ModelHostModelInfo,
  ModelHostProfile,
  ModelHostRuntimeDriver,
  ModelHostErrorCode,
} from './index.ts'
import { ModelHostError } from './index.ts'

export const ANTHROPIC_SUBSCRIPTION_POLICY = {
  permitted: true,
  checkedAt: '2026-09-04',
  reviewedAgentSdkVersion: '0.3.260',
  reviewedClaudeCodeVersion: '2.1.260',
  reason: 'Anthropic documents Claude Code as included with Claude Pro and Max and ships the Agent SDK as its supported programmatic boundary.',
  sources: [
    'https://support.claude.com/en/articles/8325606-what-is-the-pro-plan',
    'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    'https://platform.claude.com/docs/en/agent-sdk/overview',
  ],
} as const

export interface SubscriptionProviderDefinition {
  id: 'openai-codex' | 'github-copilot' | 'anthropic-claude'
  name: string
  driver: 'openai-codex-app-server' | 'github-copilot-sdk' | 'anthropic-claude-agent-sdk'
  enabled: boolean
}

export function subscriptionProviders(environment: NodeJS.ProcessEnv = process.env): readonly SubscriptionProviderDefinition[] {
  const providers: SubscriptionProviderDefinition[] = [
    { id: 'openai-codex', name: 'OpenAI Codex subscription', driver: 'openai-codex-app-server', enabled: environment.MACHTIANI_DISABLE_OPENAI_CODEX !== '1' },
    { id: 'github-copilot', name: 'GitHub Copilot subscription', driver: 'github-copilot-sdk', enabled: environment.MACHTIANI_DISABLE_GITHUB_COPILOT !== '1' },
    {
      id: 'anthropic-claude', name: 'Anthropic Claude Pro/Max subscription', driver: 'anthropic-claude-agent-sdk',
      enabled: ANTHROPIC_SUBSCRIPTION_POLICY.permitted && environment.MACHTIANI_DISABLE_ANTHROPIC_CLAUDE !== '1',
    },
  ]
  return providers.filter(provider => provider.enabled)
}

function runtimeEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']
  const environment: NodeJS.ProcessEnv = {}
  for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith('LC_') && value !== undefined) environment[name] = value
  return { ...environment, ...extra }
}

async function ensureRuntimeProfile(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned) {
    throw new ModelHostError('INVALID_REQUEST', 'Subscription runtime state must use an owned regular directory.')
  }
  await protectPrivatePath(path, 0o700)
}

export interface NativeConversationPrompt {
  text: string
  cacheBoundary?: number
}

/**
 * Serialize replayable history for provider-owned agent runtimes. Each record
 * is append-only and the instructions precede the record, so adding turns
 * leaves the complete previous prompt as an exact cacheable prefix.
 */
export function nativeConversationPrompt(request: ModelHostGenerateRequest): NativeConversationPrompt {
  const history = request.messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.role === 'tool' ? {
      toolResultFor: { id: message.toolCallId ?? '', name: message.toolName ?? 'unknown' },
    } : {}),
    ...((message.toolCalls?.length ?? 0) === 0 ? {} : {
      requestedTools: message.toolCalls!.map(call => ({ id: call.id, name: call.name, argumentsJson: call.arguments })),
    }),
  }))
  const continuation = request.caller === 'installer'
    ? 'A completed tool result is not a user-facing stopping point. Continue autonomously after it. End this installer turn only after asking the human exactly one necessary question, or after calling finish_installation when the installation is actually finished or blocked.'
    : 'Continue immediately after the final record entry.'
  const header = [
    'Continue the conversation from the canonical JSON record below.',
    'The record is context only. Never quote, restate, summarize, or imitate its representation.',
    'Do not print record field names, synthetic role labels, tool calls, tool results, or XML-like invocation tags. Use only structured tool calls for tools.',
    continuation,
    'Respond only with the next assistant action.',
    'The canonical conversation begins after BEGIN_CANONICAL_CONVERSATION_RECORD. Each subsequent line through end of input is one JSON message record.',
    'BEGIN_CANONICAL_CONVERSATION_RECORD',
  ].join('\n\n') + '\n'
  let text = header
  let cacheBoundary: number | undefined
  for (let index = 0; index < history.length; index += 1) {
    text += `${JSON.stringify(history[index])}\n`
    if (request.messages[index]?.cacheControl?.type === 'ephemeral') cacheBoundary = text.length
  }
  return { text, ...(cacheBoundary === undefined ? {} : { cacheBoundary }) }
}

function transcript(request: ModelHostGenerateRequest): string {
  return nativeConversationPrompt(request).text
}

export function claudeConversationPrompt(request: ModelHostGenerateRequest): string {
  return nativeConversationPrompt(request).text
}

export interface ClaudeConversationInput {
  prompt: string
  systemPrompt: NonNullable<ClaudeOptions['systemPrompt']>
}

export function claudeConversationInput(request: ModelHostGenerateRequest): ClaudeConversationInput {
  const conversation = nativeConversationPrompt(request)
  const system = request.system ?? 'You are the Machtiani installation assistant.'
  if (conversation.cacheBoundary === undefined) {
    return {
      prompt: conversation.text,
      systemPrompt: { type: 'custom', prompt: system, snapshot: true },
    }
  }
  const prefix = conversation.text.slice(0, conversation.cacheBoundary)
  const suffix = conversation.text.slice(conversation.cacheBoundary)
  return {
    prompt: suffix === '' ? 'Continue immediately from the canonical conversation above.' : suffix,
    systemPrompt: { type: 'custom', prompt: [system, prefix], snapshot: true },
  }
}

class EventQueue implements AsyncIterable<ModelHostEvent> {
  private values: ModelHostEvent[] = []
  private waiters: Array<() => void> = []
  private ended = false
  private failure: unknown
  push(value: ModelHostEvent): void { if (this.ended) return; this.values.push(value); this.waiters.shift()?.() }
  close(error?: unknown): void { if (this.ended) return; this.ended = true; this.failure = error; for (const wake of this.waiters.splice(0)) wake() }
  async * [Symbol.asyncIterator](): AsyncIterator<ModelHostEvent> {
    while (!this.ended || this.values.length > 0) {
      if (this.values.length > 0) { yield this.values.shift()!; continue }
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    if (this.failure !== undefined) throw this.failure
  }
}

export interface RpcMessage { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }

export interface CodexAppServerPort {
  start(): Promise<void>
  call(method: string, params?: unknown): Promise<unknown>
  respond(id: string | number, result: unknown): void
  onMessage(listener: (message: RpcMessage) => void): () => void
  close(): Promise<void>
}

export function codexStartupError(stderr: string, cause?: Error): Error {
  if (/failed to initialize (?:sqlite )?state runtime/iu.test(stderr)) {
    return new ModelHostError('RUNTIME_UNAVAILABLE', 'The bundled OpenAI runtime could not open its local state. This can happen when different Codex versions share a profile. Reconfigure OpenAI through /model to use a separate Machtiani sign-in. Do not delete your standalone Codex data.')
  }
  if (/Missing optional dependency @openai\/codex-[a-z0-9-]+/u.test(stderr)) {
    return new ModelHostError('RUNTIME_UNAVAILABLE', 'The installed OpenAI sign-in runtime is incomplete. Repair or reinstall Dear Machine, then try signing in again.')
  }
  const detail = stderr.trim().split(/\r?\n/u).at(-1)
  return cause ?? new Error(`Codex app-server exited unexpectedly${detail === undefined || detail === '' ? '' : `: ${detail}`}`)
}

class CodexAppServer implements CodexAppServerPort {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private nextId = 1
  private stderr = ''
  private failed = false

  constructor(profile: string) {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve('@openai/codex/package.json')
    this.process = spawn(process.execPath, [join(dirname(packagePath), 'bin', 'codex.js'), 'app-server'], {
      env: runtimeEnvironment({ CODEX_HOME: profile }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8192)
    })
    createInterface({ input: this.process.stdout, crlfDelay: Infinity }).on('line', line => {
      let message: RpcMessage
      try { message = JSON.parse(line) as RpcMessage } catch { return }
      if (message.id !== undefined && message.method === undefined) {
        const waiter = this.pending.get(Number(message.id))
        if (waiter !== undefined) {
          this.pending.delete(Number(message.id))
          if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'Codex app-server request failed'))
          else waiter.resolve(message.result)
        }
      } else for (const listener of this.listeners) listener(message)
    })
    const failed = (cause?: Error) => {
      if (this.failed) return
      this.failed = true
      const error = codexStartupError(this.stderr, cause)
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
      for (const listener of this.listeners) listener({ method: 'transport/error', params: { message: error.message } })
    }
    this.process.once('error', failed)
    this.process.once('exit', () => failed())
  }

  private send(value: unknown): void { this.process.stdin.write(`${JSON.stringify(value)}\n`) }
  async start(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'machtiani-installer', title: 'Machtiani Installer', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.send({ method: 'initialized' })
  }
  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.send({ method, id, ...(params === undefined ? {} : { params }) }) }
      catch (error) { this.pending.delete(id); reject(error as Error) }
    })
  }
  respond(id: string | number, result: unknown): void { this.send({ id, result }) }
  onMessage(listener: (message: RpcMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async close(): Promise<void> {
    this.failed = true
    this.process.stdin.end()
    if (this.process.exitCode === null) this.process.kill('SIGTERM')
  }
}

type AppServerFactory = (profile: string) => CodexAppServerPort

// Codex 0.157.1 reports failures in both error notifications and completed
// turns. A completed turn is not necessarily a successful generation.
function codexTurnError(value: unknown): ModelHostError {
  const error = value as { message?: unknown; codexErrorInfo?: unknown } | null
  const info = error?.codexErrorInfo
  const kind = typeof info === 'string' ? info : info !== null && typeof info === 'object' ? Object.keys(info)[0] : undefined
  const detail = kind !== undefined && info !== null && typeof info === 'object'
    ? (info as Record<string, { httpStatusCode?: unknown }>)[kind] : undefined
  const status = typeof detail?.httpStatusCode === 'number' ? detail.httpStatusCode : undefined
  let code: ModelHostErrorCode = 'INTERNAL'
  if (kind === 'contextWindowExceeded') code = 'CONTEXT_LENGTH_EXCEEDED'
  else if (kind === 'usageLimitExceeded' || kind === 'sessionBudgetExceeded') code = 'QUOTA_EXHAUSTED'
  else if (kind === 'unauthorized' || status === 401 || status === 403) code = 'AUTH_REQUIRED'
  else if (kind === 'rateLimitExceeded' || status === 429) code = 'RATE_LIMITED'
  else if (kind === 'badRequest' || status === 400 || status === 422) code = 'INVALID_REQUEST'
  else if (status === 404) code = 'MODEL_UNAVAILABLE'
  else if (kind === 'serverOverloaded' || kind === 'internalServerError' || status === 408 || (status !== undefined && status >= 500 && status <= 599) ||
    (status === undefined && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind ?? ''))) code = 'TRANSIENT_ERROR'
  // Preserve the provider's explanation, not stderr or arbitrary response data.
  const message = (typeof error?.message === 'string' ? error.message : 'Codex turn failed without error details.')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .slice(0, 4096)
  return new ModelHostError(code, `Codex turn failed${kind === undefined ? '' : ` (${kind}${status === undefined ? '' : `, HTTP ${status}`})`}: ${message}`)
}

export class OpenAICodexDriver implements ModelHostRuntimeDriver {
  constructor(private readonly profile: ModelHostProfile, private readonly factory: AppServerFactory = profile => new CodexAppServer(profile)) {}
  private async server(): Promise<CodexAppServerPort> {
    await ensureRuntimeProfile(this.profile.runtimeProfile!)
    const server = this.factory(this.profile.runtimeProfile!)
    await server.start()
    return server
  }
  async authenticated(): Promise<boolean> {
    const server = await this.server()
    try { return ((await server.call('account/read', { refreshToken: false })) as { account?: unknown }).account != null } finally { await server.close() }
  }
  async models(): Promise<readonly ModelHostModelInfo[]> {
    const server = await this.server()
    try {
      const result = await server.call('model/list', { includeHidden: false }) as { data: Array<{ id: string; displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }> }
      return result.data.map(model => ({ id: model.id, name: model.displayName, reasoningEfforts: model.supportedReasoningEfforts.map(value => value.reasoningEffort) }))
    } finally { await server.close() }
  }
  async login(interaction: ModelHostAuthInteraction, mode: ModelHostLoginMode = 'browser'): Promise<void> {
    const server = await this.server()
    let loginId: string | undefined
    try {
      const completion = new Promise<void>((resolve, reject) => server.onMessage(message => {
        if (message.method === 'transport/error') {
          reject(new ModelHostError('UPSTREAM_CHANGED', 'The pinned Codex app-server stopped during sign-in.'))
          return
        }
        if (message.method !== 'account/login/completed') return
        const result = message.params as { loginId?: string; success?: boolean; error?: string }
        if (result.loginId !== loginId) return
        if (result.success) resolve(); else reject(new Error(result.error ?? 'OpenAI sign-in did not complete'))
      }))
      if (mode === 'device_code') {
        const started = await server.call('account/login/start', { type: 'chatgptDeviceCode' }) as { loginId?: unknown; verificationUrl?: unknown; userCode?: unknown }
        if (typeof started.loginId !== 'string' || typeof started.verificationUrl !== 'string' || typeof started.userCode !== 'string') {
          throw new ModelHostError('UPSTREAM_CHANGED', 'Codex app-server returned an unreadable device sign-in response.')
        }
        loginId = started.loginId
        interaction.notify({ type: 'device_code', userCode: started.userCode, verificationUri: started.verificationUrl })
      } else {
        const started = await server.call('account/login/start', {
          type: 'chatgpt',
          useHostedLoginSuccessPage: true,
          appBrand: 'chatgpt',
        }) as { loginId?: unknown; authUrl?: unknown }
        if (typeof started.loginId !== 'string' || typeof started.authUrl !== 'string') {
          throw new ModelHostError('UPSTREAM_CHANGED', 'Codex app-server returned an unreadable browser sign-in response.')
        }
        loginId = started.loginId
        interaction.notify({
          type: 'auth_url',
          url: started.authUrl,
          instructions: 'Open this page in your browser and sign in with ChatGPT. The installer will continue when sign-in finishes.',
          waitForCompletion: true,
        })
      }
      const abort = () => { void server.call('account/login/cancel', { loginId }).catch(() => {}) }
      const cancelled = new Promise<never>((_resolve, reject) => interaction.signal?.addEventListener('abort', () => reject(new ModelHostError('CANCELLED', 'OpenAI sign-in was cancelled.')), { once: true }))
      interaction.signal?.addEventListener('abort', abort, { once: true })
      if (interaction.signal?.aborted) throw new ModelHostError('CANCELLED', 'OpenAI sign-in was cancelled.')
      try { await Promise.race([completion, cancelled]) } finally { interaction.signal?.removeEventListener('abort', abort) }
    } finally { await server.close() }
  }
  async logout(): Promise<void> { const server = await this.server(); try { await server.call('account/logout') } finally { await server.close() } }
  async * generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent> {
    const server = await this.server()
    const workspace = await mkdtemp(join(tmpdir(), 'machtiani-codex-workspace-'))
    const queue = new EventQueue()
    let threadId = ''
    let turnId = ''
    let text = ''
    let reasoning = ''
    let toolCall = false
    const stop = server.onMessage(message => {
      const params = message.params as Record<string, unknown> | undefined
      const notificationTurnId = typeof params?.turnId === 'string'
        ? params.turnId
        : typeof (params?.turn as { id?: unknown } | undefined)?.id === 'string'
          ? (params!.turn as { id: string }).id
          : undefined
      const currentTurn = params?.threadId === threadId && notificationTurnId !== undefined &&
        (turnId === '' || notificationTurnId === turnId)
      if (currentTurn && turnId === '') turnId = notificationTurnId
      if (message.method === 'transport/error') queue.close(new ModelHostError('TRANSIENT_ERROR', 'The pinned Codex app-server stopped during generation.'))
      else if (message.method === 'error' && currentTurn && params.willRetry === false) queue.close(codexTurnError(params.error))
      else if (message.method === 'item/agentMessage/delta' && currentTurn) {
        const delta = String(params.delta ?? ''); if (text === '') queue.push({ type: 'text-start', index: 0 }); text += delta; queue.push({ type: 'text-delta', index: 0, text: delta })
      } else if ((message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') && currentTurn) {
        const delta = String(params.delta ?? ''); if (reasoning === '') queue.push({ type: 'reasoning-start', index: 1 }); reasoning += delta; queue.push({ type: 'reasoning-delta', index: 1, text: delta })
      } else if (message.method === 'thread/tokenUsage/updated' && currentTurn) {
        const last = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last
        if (last !== undefined) queue.push({ type: 'usage', inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0,
          ...(last.totalTokens === undefined ? {} : { totalTokens: last.totalTokens }),
          ...(last.cachedInputTokens === undefined ? {} : { cacheReadTokens: last.cachedInputTokens }),
          ...(last.cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: last.cacheWriteInputTokens }),
          ...(last.reasoningOutputTokens === undefined ? {} : { reasoningTokens: last.reasoningOutputTokens }),
        })
      } else if (message.method === 'item/tool/call' && message.id !== undefined) {
        const call = params as { callId: string; tool: string; arguments: unknown; turnId: string }
        if (!currentTurn) return
        toolCall = true
        const args = JSON.stringify(call.arguments)
        queue.push({ type: 'tool-start', index: 2, id: call.callId, name: call.tool })
        queue.push({ type: 'tool-delta', index: 2, id: call.callId, name: call.tool, argumentsDelta: args })
        queue.push({ type: 'tool-end', index: 2, id: call.callId, name: call.tool, arguments: args })
        server.respond(message.id, { contentItems: [{ type: 'inputText', text: 'The host will execute this tool call.' }], success: true })
        void server.call('turn/interrupt', { threadId, turnId }).catch(() => {})
      } else if (message.method === 'turn/completed' && currentTurn) {
        const turn = params.turn as { status?: string; error?: unknown }
        if (turn.status === 'failed' || turn.error != null) { queue.close(codexTurnError(turn.error)); return }
        if (turn.status === 'interrupted' && !toolCall) { queue.close(new ModelHostError('CANCELLED', 'Codex turn was interrupted.')); return }
        if (turn.status !== 'completed' && turn.status !== 'interrupted') { queue.close(new ModelHostError('UPSTREAM_CHANGED', 'Codex returned an unexpected completed-turn status.')); return }
        if (!toolCall && text.trim() === '') { queue.close(new ModelHostError('EMPTY_RESPONSE', 'Codex completed the turn without answer text.')); return }
        if (text !== '') queue.push({ type: 'text-end', index: 0, text })
        if (reasoning !== '') queue.push({ type: 'reasoning-end', index: 1, text: reasoning })
        queue.push({ type: 'finish', reason: toolCall ? 'tool-calls' : request.signal?.aborted ? 'cancelled' : 'stop' })
        queue.close()
      }
    })
    const run = (async () => {
      try {
        const started = await server.call('thread/start', {
          model: request.model ?? this.profile.model, cwd: workspace, runtimeWorkspaceRoots: [], environments: [],
          approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
          baseInstructions: request.system ?? null,
          dynamicTools: (request.tools ?? []).map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters })),
        }) as { thread: { id: string } }
        threadId = started.thread.id
        const turn = await server.call('turn/start', {
          threadId, input: [{ type: 'text', text: transcript(request), text_elements: [] }], environments: [], runtimeWorkspaceRoots: [],
          effort: request.reasoningEffort ?? this.profile.reasoningEffort ?? null,
        }) as { turn: { id: string } }
        turnId = turn.turn.id
        const abort = () => { void server.call('turn/interrupt', { threadId, turnId }).catch(() => {}) }
        request.signal?.addEventListener('abort', abort, { once: true })
      } catch (error) { queue.close(error) }
    })()
    try { for await (const event of queue) yield event; await run } finally { stop(); await server.close(); await rm(workspace, { recursive: true, force: true }) }
  }
}

type CopilotFactory = (profile: string) => CopilotClient
type CopilotLoginProcess = ChildProcessByStdio<null, Readable, Readable>
type CopilotLoginFactory = (profile: string) => CopilotLoginProcess

function spawnCopilotLogin(profile: string): CopilotLoginProcess {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@github/copilot/package.json')
  return spawn(process.execPath, [join(dirname(packagePath), 'npm-loader.js'), 'login', '--device-code'], {
    env: runtimeEnvironment({ COPILOT_HOME: profile }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export class GitHubCopilotDriver implements ModelHostRuntimeDriver {
  constructor(
    private readonly profile: ModelHostProfile,
    private readonly factory: CopilotFactory = profile => new CopilotClient({ mode: 'empty', baseDirectory: profile, useLoggedInUser: true, logLevel: 'error', env: runtimeEnvironment({ COPILOT_HOME: profile }) }),
    private readonly loginFactory: CopilotLoginFactory = spawnCopilotLogin,
  ) {}
  private async client(): Promise<CopilotClient> { await ensureRuntimeProfile(this.profile.runtimeProfile!); return this.factory(this.profile.runtimeProfile!) }
  async authenticated(): Promise<boolean> { const client = await this.client(); try { await client.start(); return (await client.getAuthStatus()).isAuthenticated } finally { await client.stop().catch(() => []) } }
  async models(): Promise<readonly ModelHostModelInfo[]> {
    const client = await this.client()
    try { await client.start(); return (await client.listModels()).filter(model => model.policy?.state !== 'disabled').map(model => ({ id: model.id, name: model.name, reasoningEfforts: model.supportedReasoningEfforts ?? [] })) }
    finally { await client.stop().catch(() => []) }
  }
  async login(interaction: ModelHostAuthInteraction): Promise<void> {
    await ensureRuntimeProfile(this.profile.runtimeProfile!)
    interaction.notify({ type: 'progress', message: 'Starting GitHub device sign-in' })
    await new Promise<void>((resolve, reject) => {
      const child = this.loginFactory(this.profile.runtimeProfile!)
      let cancelled = interaction.signal?.aborted === true
      let completed = false
      const settle = (result: () => void): void => {
        if (completed) return
        completed = true
        interaction.signal?.removeEventListener('abort', abort)
        result()
      }
      const relay = (chunk: Buffer) => {
        const message = chunk.toString('utf8').trim()
        if (message !== '') interaction.notify({ type: 'info', message })
      }
      child.stdout.on('data', relay); child.stderr.on('data', relay)
      const abort = () => { cancelled = true; child.kill('SIGINT') }
      interaction.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', error => settle(() => reject(cancelled
        ? new ModelHostError('CANCELLED', 'GitHub Copilot sign-in was cancelled.')
        : error)))
      child.once('exit', code => settle(() => {
        if (cancelled) reject(new ModelHostError('CANCELLED', 'GitHub Copilot sign-in was cancelled.'))
        else if (code === 0) resolve()
        else reject(new Error('GitHub Copilot sign-in did not complete'))
      }))
      if (cancelled) abort()
    })
  }
  async logout(): Promise<void> {
    throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'Use the official GitHub Copilot CLI logout command to remove its saved sign-in.')
  }
  async * generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent> {
    const client = await this.client()
    await client.start()
    const queue = new EventQueue()
    let text = ''
    let reasoning = ''
    let toolCalled = false
    const tools: Tool[] = (request.tools ?? []).map((tool, index) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters, skipPermission: true, defer: 'never', isTerminal: true,
      handler: (args, invocation) => {
        toolCalled = true
        const id = invocation.toolCallId
        const serialized = JSON.stringify(args)
        queue.push({ type: 'tool-start', index: index + 2, id, name: tool.name })
        queue.push({ type: 'tool-delta', index: index + 2, id, name: tool.name, argumentsDelta: serialized })
        queue.push({ type: 'tool-end', index: index + 2, id, name: tool.name, arguments: serialized })
        return 'The host will execute this tool call.'
      },
    }))
    let session: CopilotSession | undefined
    const run = (async () => {
      try {
        session = await client.createSession({
          clientName: 'machtiani-installer', model: request.model ?? this.profile.model,
          ...(request.reasoningEffort ?? this.profile.reasoningEffort) === undefined ? {} : { reasoningEffort: (request.reasoningEffort ?? this.profile.reasoningEffort) as never },
          systemMessage: { mode: 'replace', content: request.system ?? 'You are the Machtiani installation assistant.' },
          tools, availableTools: tools.map(tool => tool.name), enableConfigDiscovery: false,
        })
        session.on('assistant.message_start', () => queue.push({ type: 'text-start', index: 0 }))
        session.on('assistant.message_delta', event => { text += event.data.deltaContent; queue.push({ type: 'text-delta', index: 0, text: event.data.deltaContent }) })
        session.on('assistant.reasoning_delta', event => { if (reasoning === '') queue.push({ type: 'reasoning-start', index: 1 }); reasoning += event.data.deltaContent; queue.push({ type: 'reasoning-delta', index: 1, text: event.data.deltaContent }) })
        session.on('assistant.usage', event => queue.push({ type: 'usage', inputTokens: event.data.inputTokens ?? 0, outputTokens: event.data.outputTokens ?? 0,
          ...(event.data.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.data.cacheReadTokens }),
          ...(event.data.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.data.cacheWriteTokens }),
          ...(event.data.reasoningTokens === undefined ? {} : { reasoningTokens: event.data.reasoningTokens }),
        }))
        const abort = () => { void session?.abort() }
        request.signal?.addEventListener('abort', abort, { once: true })
        await session.sendAndWait(transcript(request), 10 * 60_000)
        if (text !== '') queue.push({ type: 'text-end', index: 0, text })
        if (reasoning !== '') queue.push({ type: 'reasoning-end', index: 1, text: reasoning })
        queue.push({ type: 'finish', reason: toolCalled ? 'tool-calls' : request.signal?.aborted ? 'cancelled' : 'stop' })
        queue.close()
      } catch (error) { queue.close(error) }
    })()
    try { for await (const event of queue) yield event; await run } finally { await session?.disconnect().catch(() => {}); await client.stop().catch(() => []) }
  }
}

export type ClaudeCliProcessFactory = (profile: string, args: readonly string[]) => ChildProcessWithoutNullStreams

function claudeNativeExecutable(): string {
  const configuredExecutable = process.env.MACHTIANI_CLAUDE_EXECUTABLE
  if (configuredExecutable !== undefined) {
    if (!isAbsolute(configuredExecutable)) {
      throw new ModelHostError('INVALID_REQUEST', 'MACHTIANI_CLAUDE_EXECUTABLE must be an absolute path.')
    }
    return configuredExecutable
  }
  const platform = process.platform
  const architecture = process.arch
  if ((platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') ||
    (architecture !== 'x64' && architecture !== 'arm64')) {
    throw new ModelHostError('UNSUPPORTED_CAPABILITY', `Claude Code is not packaged for ${platform}-${architecture}.`)
  }
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  const libc = platform === 'linux' && report?.header?.glibcVersionRuntime === undefined ? '-musl' : ''
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${architecture}${libc}`
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
  try {
    return join(dirname(sdkRequire.resolve(`${packageName}/package.json`)), platform === 'win32' ? 'claude.exe' : 'claude')
  } catch {
    throw new ModelHostError('UPSTREAM_CHANGED', `The pinned Claude Agent SDK runtime for ${platform}-${architecture}${libc} is missing.`)
  }
}

function spawnClaudeCli(profile: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(claudeNativeExecutable(), [...args], {
    env: runtimeEnvironment({ CLAUDE_CONFIG_DIR: profile, CLAUDE_AGENT_SDK_CLIENT_APP: 'machtiani-installer/0.1.0' }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

interface ClaudeCliResult { code: number | null; stdout: string; stderr: string }

export class ClaudeCliAuth {
  constructor(private readonly factory: ClaudeCliProcessFactory = spawnClaudeCli) {}

  private async command(profile: string, args: readonly string[]): Promise<ClaudeCliResult> {
    return await new Promise((resolve, reject) => {
      const child = this.factory(profile, args)
      let stdout = ''
      let stderr = ''
      const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-65_536)
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.once('error', reject)
      child.once('exit', code => resolve({ code, stdout, stderr }))
      child.stdin.end()
    })
  }

  async authenticated(profile: string): Promise<boolean> {
    const result = await this.command(profile, ['auth', 'status', '--json'])
    let status: { loggedIn?: unknown }
    try { status = JSON.parse(result.stdout) as { loggedIn?: unknown } }
    catch {
      throw new ModelHostError('UPSTREAM_CHANGED', 'Claude Code returned an unreadable authentication status.')
    }
    if (typeof status.loggedIn !== 'boolean') {
      throw new ModelHostError('UPSTREAM_CHANGED', 'Claude Code authentication status no longer has the reviewed shape.')
    }
    return status.loggedIn
  }

  async login(profile: string, interaction: ModelHostAuthInteraction): Promise<void> {
    interaction.notify({ type: 'progress', message: 'Starting Claude Pro or Max sign-in' })
    await new Promise<void>((resolve, reject) => {
      const child = this.factory(profile, ['auth', 'login', '--claudeai'])
      let output = ''
      let announcedUrl = false
      let askedForCode = false
      let cancelled = interaction.signal?.aborted === true
      let promptFailure: unknown
      let completed = false
      const settle = (result: () => void): void => {
        if (completed) return
        completed = true
        interaction.signal?.removeEventListener('abort', abort)
        result()
      }
      const abort = () => { cancelled = true; child.kill('SIGINT') }
      const consume = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-65_536)
        const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
        if (!announcedUrl) {
          const url = /https:\/\/[^\s]+/u.exec(plain)?.[0]
          if (url !== undefined) {
            announcedUrl = true
            interaction.notify({
              type: 'auth_url', url,
              instructions: 'Open this page in your browser, sign in to Claude, then return here and paste the authorization code.',
            })
          }
        }
        if (!askedForCode && /Paste code here if prompted\s*>/iu.test(plain)) {
          askedForCode = true
          void interaction.prompt({
            type: 'manual_code',
            message: 'Paste the authorization code from Claude and press Enter.',
            ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
          }).then(code => {
            if (!cancelled) child.stdin.write(`${code.trim()}\n`)
          }).catch(error => {
            promptFailure = error
            child.kill('SIGINT')
          })
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      interaction.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', error => settle(() => reject(cancelled
        ? new ModelHostError('CANCELLED', 'Claude sign-in was cancelled.')
        : error)))
      child.once('exit', code => settle(() => {
        if (cancelled) reject(new ModelHostError('CANCELLED', 'Claude sign-in was cancelled.'))
        else if (promptFailure !== undefined) reject(promptFailure)
        else if (code === 0) resolve()
        else reject(new ModelHostError('AUTH_REQUIRED', 'Claude sign-in did not complete. You can try again from the provider wizard.'))
      }))
      if (cancelled) abort()
    })
    if (!await this.authenticated(profile)) {
      throw new ModelHostError('AUTH_REQUIRED', 'Claude Code finished sign-in but did not report an authenticated Claude account.')
    }
  }

  async logout(profile: string): Promise<void> {
    const result = await this.command(profile, ['auth', 'logout'])
    if (result.code !== 0) throw new ModelHostError('INTERNAL', 'Claude Code could not remove the saved sign-in.')
  }
}

export type ClaudeQueryFactory = (parameters: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => ClaudeQuery

interface ClaudeStreamBlock {
  kind: 'text' | 'reasoning' | 'tool'
  text: string
  id?: string
  name?: string
}

function claudeFailure(error: unknown): ModelHostError {
  if (error instanceof ModelHostError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:auth|oauth|token|credential).*(?:expired|revoked)|(?:expired|revoked).*(?:auth|oauth|token|credential)/iu.test(message)) {
    return new ModelHostError('AUTH_EXPIRED', 'The Claude subscription sign-in has expired or was revoked.')
  }
  if (/auth|login|oauth|credential/iu.test(message)) return new ModelHostError('AUTH_REQUIRED', 'Claude sign-in is required or has expired.')
  if (/rate.?limit|too many requests/iu.test(message)) return new ModelHostError('RATE_LIMITED', 'Claude temporarily rate-limited this request.')
  if (/quota|usage limit|credit/iu.test(message)) return new ModelHostError('QUOTA_EXHAUSTED', 'The Claude subscription usage limit has been reached.')
  if (/model.+(?:not found|unavailable)|invalid model/iu.test(message)) return new ModelHostError('MODEL_UNAVAILABLE', 'The selected Claude model is unavailable.')
  return new ModelHostError('INTERNAL', 'Claude Code could not complete the model request.')
}

function claudeEffort(value: string | undefined): NonNullable<ClaudeOptions['effort']> | undefined {
  if (value === undefined) return undefined
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value
  throw new ModelHostError('INVALID_REQUEST', `Claude does not support the reasoning effort ${value}.`)
}

function claudeTools(request: ModelHostGenerateRequest) {
  return (request.tools ?? []).map(declaration => {
    let schema: z.ZodType
    try { schema = z.fromJSONSchema(declaration.parameters as Parameters<typeof z.fromJSONSchema>[0]) }
    catch { throw new ModelHostError('INVALID_REQUEST', `The ${declaration.name} tool has a JSON Schema Claude cannot load.`) }
    if (!(schema instanceof z.ZodObject)) {
      throw new ModelHostError('INVALID_REQUEST', `The ${declaration.name} tool arguments must use an object JSON Schema.`)
    }
    return claudeTool(declaration.name, declaration.description, schema.shape, async () => ({
      content: [{ type: 'text', text: 'The host will execute this tool call.' }],
    }))
  })
}

export class AnthropicClaudeDriver implements ModelHostRuntimeDriver {
  constructor(
    private readonly profile: ModelHostProfile,
    private readonly factory: ClaudeQueryFactory = claudeQuery,
    private readonly auth: Pick<ClaudeCliAuth, 'authenticated' | 'login' | 'logout'> = new ClaudeCliAuth(),
  ) {}

  private async prepare(): Promise<{ profile: string; executable: string }> {
    const profile = this.profile.runtimeProfile!
    await ensureRuntimeProfile(profile)
    return { profile, executable: claudeNativeExecutable() }
  }

  private options(profile: string, executable: string): ClaudeOptions {
    return {
      cwd: profile,
      pathToClaudeCodeExecutable: executable,
      env: runtimeEnvironment({
        CLAUDE_CONFIG_DIR: profile,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'machtiani-installer/0.1.0',
      }),
      settingSources: [],
      plugins: [],
      persistSession: false,
      strictMcpConfig: true,
    }
  }

  async authenticated(): Promise<boolean> {
    const { profile } = await this.prepare()
    return await this.auth.authenticated(profile)
  }

  async models(): Promise<readonly ModelHostModelInfo[]> {
    const { profile, executable } = await this.prepare()
    const idle = new AbortController()
    async function * noInput(): AsyncIterable<never> {
      await new Promise<void>(resolve => idle.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    const current = this.factory({ prompt: noInput(), options: this.options(profile, executable) })
    try {
      return (await current.supportedModels()).map(model => ({
        id: model.value,
        name: model.displayName,
        reasoningEfforts: model.supportsEffort ? (model.supportedEffortLevels ?? ['low', 'medium', 'high']) : [],
      }))
    } catch (error) { throw claudeFailure(error) }
    finally { idle.abort(); current.close() }
  }

  async login(interaction: ModelHostAuthInteraction): Promise<void> {
    const { profile } = await this.prepare()
    await this.auth.login(profile, interaction)
  }

  async logout(): Promise<void> {
    const { profile } = await this.prepare()
    await this.auth.logout(profile)
  }

  async * generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent> {
    const { profile, executable } = await this.prepare()
    const workspace = await mkdtemp(join(tmpdir(), 'machtiani-claude-workspace-'))
    const controller = new AbortController()
    let externalCancellation = request.signal?.aborted === true
    let toolCalled = false
    let finished = false
    let streamedText = false
    const blocks = new Map<number, ClaudeStreamBlock>()
    const declaredNames = new Set((request.tools ?? []).map(value => value.name))
    const externalAbort = () => { externalCancellation = true; controller.abort() }
    request.signal?.addEventListener('abort', externalAbort, { once: true })
    if (externalCancellation) controller.abort()
    const definitions = claudeTools(request)
    const server = createSdkMcpServer({ name: 'machtiani-installer', version: '0.1.0', tools: definitions, alwaysLoad: true })
    const allowedTools = definitions.map(value => `mcp__machtiani__${value.name}`)
    const effort = claudeEffort(request.reasoningEffort ?? this.profile.reasoningEffort)
    const conversation = claudeConversationInput(request)
    const current = this.factory({
      prompt: conversation.prompt,
      options: {
        ...this.options(profile, executable),
        cwd: workspace,
        abortController: controller,
        includePartialMessages: true,
        systemPrompt: conversation.systemPrompt,
        model: request.model ?? this.profile.model,
        ...(effort === undefined ? {} : { effort, thinking: { type: 'adaptive', display: 'summarized' } }),
        maxTurns: 1,
        tools: [],
        mcpServers: { machtiani: server },
        allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        permissionPrompts: 'none',
      },
    })
    try {
      for await (const message of current as AsyncIterable<ClaudeMessage>) {
        if (message.type === 'assistant' && message.error !== undefined) throw new Error(message.error)
        if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          const event = message.event
          if (event.type === 'content_block_start') {
            const block = event.content_block
            if (block.type === 'text') {
              blocks.set(event.index, { kind: 'text', text: '' })
              streamedText = true
              yield { type: 'text-start', index: event.index }
            } else if (block.type === 'thinking') {
              blocks.set(event.index, { kind: 'reasoning', text: '' })
              yield { type: 'reasoning-start', index: event.index }
            } else if (block.type === 'tool_use') {
              const rawName = block.name
              const name = rawName.startsWith('mcp__machtiani__') ? rawName.slice('mcp__machtiani__'.length) : rawName
              if (!declaredNames.has(name)) throw new ModelHostError('UPSTREAM_CHANGED', `Claude requested an undeclared tool: ${name}`)
              toolCalled = true
              blocks.set(event.index, { kind: 'tool', text: '', id: block.id, name })
              yield { type: 'tool-start', index: event.index, id: block.id, name }
            }
          } else if (event.type === 'content_block_delta') {
            const state = blocks.get(event.index)
            if (state === undefined) continue
            if (state.kind === 'text' && event.delta.type === 'text_delta') {
              state.text += event.delta.text
              yield { type: 'text-delta', index: event.index, text: event.delta.text }
            } else if (state.kind === 'reasoning' && event.delta.type === 'thinking_delta') {
              state.text += event.delta.thinking
              yield { type: 'reasoning-delta', index: event.index, text: event.delta.thinking }
            } else if (state.kind === 'tool' && event.delta.type === 'input_json_delta') {
              state.text += event.delta.partial_json
              yield { type: 'tool-delta', index: event.index, id: state.id!, name: state.name!, argumentsDelta: event.delta.partial_json }
            }
          } else if (event.type === 'content_block_stop') {
            const state = blocks.get(event.index)
            if (state?.kind === 'text') yield { type: 'text-end', index: event.index, text: state.text }
            else if (state?.kind === 'reasoning') yield { type: 'reasoning-end', index: event.index, text: state.text }
            else if (state?.kind === 'tool') yield { type: 'tool-end', index: event.index, id: state.id!, name: state.name!, arguments: state.text }
          } else if (event.type === 'message_stop' && toolCalled) controller.abort()
        } else if (message.type === 'result') {
          yield {
            type: 'usage', inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          }
          if (message.subtype === 'success' && message.is_error) throw new Error(message.result)
          if (message.subtype !== 'success' && !toolCalled) throw new Error(message.errors.join('; '))
          if (message.subtype === 'success' && !streamedText && message.result !== '' && !toolCalled) {
            yield { type: 'text-start', index: 0 }
            yield { type: 'text-delta', index: 0, text: message.result }
            yield { type: 'text-end', index: 0, text: message.result }
          }
          yield { type: 'finish', reason: toolCalled ? 'tool-calls' : externalCancellation ? 'cancelled' : 'stop' }
          finished = true
        }
      }
      if (!finished) yield { type: 'finish', reason: toolCalled ? 'tool-calls' : externalCancellation ? 'cancelled' : 'stop' }
    } catch (error) {
      if (toolCalled) yield { type: 'finish', reason: 'tool-calls' }
      else if (externalCancellation || error instanceof ClaudeAbortError) yield { type: 'finish', reason: 'cancelled' }
      else throw claudeFailure(error)
    } finally {
      request.signal?.removeEventListener('abort', externalAbort)
      current.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

export function subscriptionDriver(profile: ModelHostProfile): ModelHostRuntimeDriver {
  if (profile.driver === 'openai-codex-app-server') return new OpenAICodexDriver(profile)
  if (profile.driver === 'github-copilot-sdk') return new GitHubCopilotDriver(profile)
  if (profile.driver === 'anthropic-claude-agent-sdk') return new AnthropicClaudeDriver(profile)
  throw new ModelHostError('INVALID_REQUEST', `Unsupported subscription model driver: ${profile.driver}`)
}
