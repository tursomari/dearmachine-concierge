import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  builtinModels,
} from '@earendil-works/pi-ai/providers/all'
import {
  type AssistantMessageEvent,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  getSupportedThinkingLevels,
  type Message as PiMessage,
  type Models,
  type ThinkingLevel,
  type Tool,
} from '@earendil-works/pi-ai'

export const MODEL_HOST_PROTOCOL_VERSION = 1 as const
export const MODEL_HOST_PROVIDER = 'machtiani-model-host'

export type ModelHostAuthMethod = 'api_key' | 'subscription'

export interface ModelHostProfile {
  version: 1
  driver: string
  provider: string
  authMethod: ModelHostAuthMethod
  model: string
  reasoningEffort?: string
  credential?: {
    kind: 'environment-file'
    path: string
    variable: string
  }
  runtimeProfile?: string
}

export interface ModelHostMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  toolCalls?: readonly { id: string; name: string; arguments: string }[]
  reasoning?: string
}

export interface ModelHostTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ModelHostGenerateRequest {
  caller: 'installer' | 'machtiani' | string
  sessionId: string
  messages: readonly ModelHostMessage[]
  system?: string
  tools?: readonly ModelHostTool[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  model?: string
  reasoningEffort?: string
  signal?: AbortSignal
}

export type ModelHostEvent =
  | { type: 'text-start'; index: number }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'text-end'; index: number; text: string }
  | { type: 'reasoning-start'; index: number }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'reasoning-end'; index: number; text: string }
  | { type: 'tool-start'; index: number; id: string; name: string }
  | { type: 'tool-delta'; index: number; id: string; name: string; argumentsDelta: string }
  | { type: 'tool-end'; index: number; id: string; name: string; arguments: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' }

export type ModelHostErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'MODEL_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'CANCELLED'
  | 'UPSTREAM_CHANGED'
  | 'INVALID_REQUEST'
  | 'INTERNAL'

export class ModelHostError extends Error {
  constructor(
    readonly code: ModelHostErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ModelHostError'
  }
}

export interface ApiKeyProviderDefinition {
  id: 'openrouter' | 'deepseek' | 'openai'
  name: string
  variable: 'OPENROUTER_API_KEY' | 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY'
}

export const API_KEY_PROVIDERS: readonly ApiKeyProviderDefinition[] = [
  { id: 'openrouter', name: 'OpenRouter', variable: 'OPENROUTER_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', variable: 'DEEPSEEK_API_KEY' },
  { id: 'openai', name: 'OpenAI API', variable: 'OPENAI_API_KEY' },
]

function providerDefinition(provider: string): ApiKeyProviderDefinition {
  const result = API_KEY_PROVIDERS.find(candidate => candidate.id === provider)
  if (result === undefined) throw new ModelHostError('INVALID_REQUEST', `Unsupported model provider: ${provider}`)
  return result
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned) {
    throw new ModelHostError('INVALID_REQUEST', 'Model host state must use an owned regular directory.')
  }
  await chmod(path, 0o700)
}

async function privateFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || !owned || (metadata.mode & 0o077) !== 0) {
      throw new ModelHostError('INVALID_REQUEST', 'Model host credentials must be an owned private regular file.')
    }
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseEnvironment(content: string | undefined): Map<string, string> {
  const values = new Map<string, string>()
  if (content === undefined) return values
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line)
    if (match === null) throw new ModelHostError('INVALID_REQUEST', 'The private provider environment file is malformed.')
    values.set(match[1]!, match[2]!)
  }
  return values
}

function validCredential(value: string): boolean {
  return value.trim() !== '' && value === value.trim() && !/[\s\0]/u.test(value)
}

async function writePrivate(path: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path))
  const existing = await privateFile(path)
  void existing
  const temporary = join(dirname(path), `.model-host-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function writeApiKeyCredential(path: string, provider: string, key: string): Promise<void> {
  const definition = providerDefinition(provider)
  if (!validCredential(key)) throw new ModelHostError('INVALID_REQUEST', 'The API key must be one nonempty line without whitespace.')
  const values = parseEnvironment(await privateFile(path))
  values.set(definition.variable, key)
  const supported = new Set(API_KEY_PROVIDERS.map(candidate => candidate.variable))
  const unknown = [...values.keys()].filter(name => !supported.has(name as ApiKeyProviderDefinition['variable']))
  if (unknown.length > 0) throw new ModelHostError('INVALID_REQUEST', `The provider environment contains unsupported assignments: ${unknown.join(', ')}`)
  const content = API_KEY_PROVIDERS.flatMap(candidate => {
    const value = values.get(candidate.variable)
    return value === undefined ? [] : [`${candidate.variable}=${value}`]
  }).join('\n') + '\n'
  await writePrivate(path, content)
}

export async function removeApiKeyCredential(path: string, provider: string): Promise<void> {
  const definition = providerDefinition(provider)
  const values = parseEnvironment(await privateFile(path))
  values.delete(definition.variable)
  const content = API_KEY_PROVIDERS.flatMap(candidate => {
    const value = values.get(candidate.variable)
    return value === undefined ? [] : [`${candidate.variable}=${value}`]
  }).join('\n')
  await writePrivate(path, content === '' ? '' : `${content}\n`)
}

export async function readApiKeyCredential(path: string, provider: string): Promise<string | undefined> {
  const definition = providerDefinition(provider)
  const value = parseEnvironment(await privateFile(path)).get(definition.variable)
  if (value === undefined || value === '') return undefined
  if (!validCredential(value)) throw new ModelHostError('AUTH_REQUIRED', `The saved ${definition.name} API key is invalid. Run machtiani auth login.`)
  return value
}

export async function saveModelHostProfile(path: string, profile: ModelHostProfile): Promise<void> {
  validateProfile(profile)
  await writePrivate(path, `${JSON.stringify(profile, undefined, 2)}\n`)
}

export async function loadModelHostProfile(path: string): Promise<ModelHostProfile> {
  const content = await privateFile(path)
  if (content === undefined) throw new ModelHostError('AUTH_REQUIRED', `The shared model profile was not found at ${path}.`)
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new ModelHostError('INVALID_REQUEST', 'The shared model profile is not valid JSON.') }
  validateProfile(value)
  return value
}

function validateProfile(value: unknown): asserts value is ModelHostProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ModelHostError('INVALID_REQUEST', 'The shared model profile is invalid.')
  const profile = value as Partial<ModelHostProfile>
  if (profile.version !== 1 || typeof profile.driver !== 'string' || typeof profile.provider !== 'string' ||
    (profile.authMethod !== 'api_key' && profile.authMethod !== 'subscription') || typeof profile.model !== 'string' || profile.model === '') {
    throw new ModelHostError('INVALID_REQUEST', 'The shared model profile is invalid.')
  }
  if (profile.authMethod === 'api_key') {
    const expected = providerDefinition(profile.provider)
    if (profile.driver !== 'pi-ai' || profile.credential?.kind !== 'environment-file' ||
      profile.credential.variable !== expected.variable || typeof profile.credential.path !== 'string' || profile.credential.path === '') {
      throw new ModelHostError('INVALID_REQUEST', 'The API-key model profile has an invalid credential reference.')
    }
  }
}

class FileCredentialStore implements CredentialStore {
  constructor(private readonly profile: ModelHostProfile) {}

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== this.profile.provider || this.profile.credential === undefined) return undefined
    const key = await readApiKeyCredential(this.profile.credential.path, providerId)
    return key === undefined ? undefined : { type: 'api_key', key }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.read(this.profile.provider) === undefined
      ? []
      : [{ providerId: this.profile.provider, type: 'api_key' }]
  }

  async modify(providerId: string, mutate: (credential: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const next = await mutate(await this.read(providerId))
    if (next === undefined) {
      await removeApiKeyCredential(this.profile.credential!.path, providerId)
      return undefined
    }
    if (next.type !== 'api_key' || next.key === undefined) throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'This provider requires API-key authentication.')
    await writeApiKeyCredential(this.profile.credential!.path, providerId, next.key)
    return next
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === this.profile.provider && this.profile.credential !== undefined) {
      await removeApiKeyCredential(this.profile.credential.path, providerId)
    }
  }
}

function hostModels(profile: ModelHostProfile): Models {
  return builtinModels({
    credentials: new FileCredentialStore(profile),
    authContext: {
      env: async name => {
        if (profile.credential?.variable !== name) return undefined
        return await readApiKeyCredential(profile.credential.path, profile.provider)
      },
      fileExists: async () => false,
    },
  })
}

export interface ModelHostModelInfo {
  id: string
  name: string
  reasoningEfforts: readonly string[]
}

export interface ModelHostProviderInfo {
  id: string
  name: string
  variable: string
}

export function apiKeyProviders(): readonly ModelHostProviderInfo[] {
  const models = builtinModels()
  return API_KEY_PROVIDERS.flatMap(definition => models.getProvider(definition.id) === undefined ? [] : [{ ...definition }])
}

export function apiKeyModels(provider: string): readonly ModelHostModelInfo[] {
  providerDefinition(provider)
  return builtinModels().getModels(provider).map(model => ({
    id: model.id,
    name: model.name,
    reasoningEfforts: getSupportedThinkingLevels(model),
  }))
}

function piMessages(messages: readonly ModelHostMessage[]): PiMessage[] {
  return messages.flatMap((message): PiMessage[] => {
    if (message.role === 'system') return []
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || message.toolName === undefined) throw new ModelHostError('INVALID_REQUEST', 'Tool results require a call ID and tool name.')
      return [{
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [{ type: 'text', text: message.content }],
        isError: false,
        timestamp: Date.now(),
      }]
    }
    if (message.role === 'assistant') {
      return [{
        role: 'assistant',
        content: [
          ...(message.reasoning === undefined || message.reasoning === '' ? [] : [{ type: 'thinking' as const, thinking: message.reasoning }]),
          ...(message.content === '' ? [] : [{ type: 'text' as const, text: message.content }]),
          ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: JSON.parse(call.arguments) as Record<string, unknown> })),
        ],
        api: 'openai-completions',
        provider: 'machtiani-model-host',
        model: 'replay',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: (message.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      }]
    }
    return [{ role: 'user', content: message.content, timestamp: Date.now() }]
  })
}

function systemPrompt(request: ModelHostGenerateRequest): string | undefined {
  const embedded = request.messages.filter(message => message.role === 'system').map(message => message.content)
  const values = [...(request.system === undefined || request.system === '' ? [] : [request.system]), ...embedded]
  return values.length === 0 ? undefined : values.join('\n\n')
}

function mappedError(message: string): ModelHostError {
  if (/abort|cancel/iu.test(message)) return new ModelHostError('CANCELLED', 'The model request was cancelled.')
  if (/401|403|auth|credential|api key/iu.test(message)) return new ModelHostError('AUTH_REQUIRED', 'The model provider needs authentication. Run machtiani auth login.')
  if (/429|rate.?limit/iu.test(message)) return new ModelHostError('RATE_LIMITED', 'The model provider is temporarily rate-limited.')
  if (/quota|credit|billing/iu.test(message)) return new ModelHostError('QUOTA_EXHAUSTED', 'The model provider account has no available usage.')
  if (/model.*(?:not found|unavailable)|404/iu.test(message)) return new ModelHostError('MODEL_UNAVAILABLE', 'The selected model is no longer available.')
  return new ModelHostError('INTERNAL', 'The model provider request failed.')
}

export class ModelHost {
  constructor(readonly profile: ModelHostProfile) { validateProfile(profile) }

  static async open(profilePath: string): Promise<ModelHost> {
    return new ModelHost(await loadModelHostProfile(profilePath))
  }

  async authenticated(): Promise<boolean> {
    if (this.profile.authMethod !== 'api_key' || this.profile.credential === undefined) return false
    return await readApiKeyCredential(this.profile.credential.path, this.profile.provider) !== undefined
  }

  models(): readonly ModelHostModelInfo[] { return apiKeyModels(this.profile.provider) }

  async * generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent> {
    if (request.sessionId.trim() === '' || request.caller.trim() === '') throw new ModelHostError('INVALID_REQUEST', 'Generation requires caller and session identity.')
    if (!await this.authenticated()) throw new ModelHostError('AUTH_REQUIRED', `Sign in to ${providerDefinition(this.profile.provider).name} before using this model.`)
    const models = hostModels(this.profile)
    const modelId = request.model ?? this.profile.model
    const model = models.getModel(this.profile.provider, modelId)
    if (model === undefined) throw new ModelHostError('MODEL_UNAVAILABLE', `The selected model ${modelId} is not in the pinned provider catalogue.`)
    const toolNames = new Map<string, string>()
    for (const message of request.messages) for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name)
    const prompt = systemPrompt(request)
    const context = {
      ...(prompt === undefined ? {} : { systemPrompt: prompt }),
      messages: piMessages(request.messages),
      ...(request.tools === undefined ? {} : { tools: request.tools as unknown as Tool[] }),
    }
    const options = {
      ...(request.reasoningEffort ?? this.profile.reasoningEffort) === undefined ? {} : { reasoning: (request.reasoningEffort ?? this.profile.reasoningEffort) as ThinkingLevel },
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(request.stop === undefined ? {} : { stopSequences: [...request.stop] }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    try {
      for await (const event of models.streamSimple(model, context, options)) {
        const mapped = mapPiEvent(event, toolNames)
        for (const item of mapped) yield item
      }
    } catch (error) {
      throw mappedError(error instanceof Error ? error.message : String(error))
    }
  }
}

function mapPiEvent(event: AssistantMessageEvent, toolNames: Map<string, string>): ModelHostEvent[] {
  switch (event.type) {
    case 'start': return []
    case 'text_start': return [{ type: 'text-start', index: event.contentIndex }]
    case 'text_delta': return [{ type: 'text-delta', index: event.contentIndex, text: event.delta }]
    case 'text_end': return [{ type: 'text-end', index: event.contentIndex, text: event.content }]
    case 'thinking_start': return [{ type: 'reasoning-start', index: event.contentIndex }]
    case 'thinking_delta': return [{ type: 'reasoning-delta', index: event.contentIndex, text: event.delta }]
    case 'thinking_end': return [{ type: 'reasoning-end', index: event.contentIndex, text: event.content }]
    case 'toolcall_start': {
      const call = event.partial.content[event.contentIndex]
      if (call?.type !== 'toolCall') return []
      toolNames.set(call.id, call.name)
      return [{ type: 'tool-start', index: event.contentIndex, id: call.id, name: call.name }]
    }
    case 'toolcall_delta': {
      const call = event.partial.content[event.contentIndex]
      if (call?.type !== 'toolCall') return []
      toolNames.set(call.id, call.name)
      return [{ type: 'tool-delta', index: event.contentIndex, id: call.id, name: call.name, argumentsDelta: event.delta }]
    }
    case 'toolcall_end': {
      toolNames.set(event.toolCall.id, event.toolCall.name)
      return [{ type: 'tool-end', index: event.contentIndex, id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) }]
    }
    case 'done': return [
      { type: 'usage', inputTokens: event.message.usage.input, outputTokens: event.message.usage.output, totalTokens: event.message.usage.totalTokens, cacheReadTokens: event.message.usage.cacheRead, cacheWriteTokens: event.message.usage.cacheWrite, ...(event.message.usage.reasoning === undefined ? {} : { reasoningTokens: event.message.usage.reasoning }) },
      { type: 'finish', reason: event.reason === 'length' ? 'max-tokens' : event.reason === 'toolUse' ? 'tool-calls' : 'stop' },
    ]
    case 'error': throw mappedError(event.error.errorMessage ?? event.reason)
  }
}

interface ProtocolRequest { v: number; id: string | number; method: string; params?: unknown }

function protocolError(error: unknown): { code: ModelHostErrorCode; message: string; retryAfterMs?: number } {
  const mapped = error instanceof ModelHostError ? error : mappedError(error instanceof Error ? error.message : String(error))
  return { code: mapped.code, message: mapped.message, ...(mapped.retryAfterMs === undefined ? {} : { retryAfterMs: mapped.retryAfterMs }) }
}

type HostSession = Pick<ModelHost, 'authenticated' | 'generate' | 'models' | 'profile'>

export async function serveModelHost(
  profilePath: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  openHost: (path: string) => Promise<HostSession> = ModelHost.open,
): Promise<void> {
  const active = new Map<string | number, AbortController>()
  const tasks = new Set<Promise<void>>()
  const send = (value: unknown) => { output.write(`${JSON.stringify(value)}\n`) }
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let request: ProtocolRequest
    try { request = JSON.parse(line) as ProtocolRequest } catch { send({ v: MODEL_HOST_PROTOCOL_VERSION, id: null, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON request.' } }); continue }
    if (request.v !== MODEL_HOST_PROTOCOL_VERSION || (typeof request.id !== 'string' && typeof request.id !== 'number')) {
      send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id ?? null, error: { code: 'INVALID_REQUEST', message: 'Unsupported protocol request.' } })
      continue
    }
    try {
      const host = await openHost(profilePath)
      if (request.method === 'initialize') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { protocolVersion: MODEL_HOST_PROTOCOL_VERSION, capabilities: ['models', 'auth', 'generate', 'stream', 'cancel', 'usage'] } })
      else if (request.method === 'models/list') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { provider: host.profile.provider, models: host.models() } })
      else if (request.method === 'auth/status') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { authenticated: await host.authenticated(), method: host.profile.authMethod } })
      else if (request.method === 'auth/login') throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'Interactive sign-in must be run with machtiani auth login.')
      else if (request.method === 'auth/logout') {
        if (host.profile.credential !== undefined) await removeApiKeyCredential(host.profile.credential.path, host.profile.provider)
        send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { authenticated: false } })
      } else if (request.method === 'generation/cancel') {
        const target = (request.params as { id?: unknown } | undefined)?.id
        const controller = typeof target === 'string' || typeof target === 'number' ? active.get(target) : undefined
        controller?.abort()
        send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { cancelled: controller !== undefined } })
      } else if (request.method === 'generation/start') {
        const controller = new AbortController()
        active.set(request.id, controller)
        const params = { ...(request.params as ModelHostGenerateRequest), signal: controller.signal }
        const task = (async () => {
          try {
            for await (const event of host.generate(params)) send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, event })
            send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { completed: true } })
          } catch (error) {
            send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, error: protocolError(error) })
          } finally { active.delete(request.id) }
        })()
        tasks.add(task)
        void task.finally(() => tasks.delete(task))
      } else throw new ModelHostError('INVALID_REQUEST', `Unknown model-host method: ${request.method}`)
    } catch (error) {
      send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, error: protocolError(error) })
    }
  }
  await Promise.allSettled([...tasks])
}
