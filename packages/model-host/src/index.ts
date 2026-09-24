import { protectPrivatePath, hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  builtinModels,
} from '@earendil-works/pi-ai/providers/all'
import {
  type AssistantMessageEvent,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Model,
  type Message as PiMessage,
  type Models,
  type ThinkingLevel,
  type Tool,
} from '@earendil-works/pi-ai'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { subscriptionDriver } from './subscription-drivers.ts'

export { ClaudeCliAuth, ANTHROPIC_SUBSCRIPTION_POLICY, subscriptionProviders } from './subscription-drivers.ts'

export const MODEL_HOST_PROTOCOL_VERSION = 1 as const
export const MODEL_HOST_PROVIDER = 'machtiani-model-host'

export type ModelHostAuthMethod = 'api_key' | 'optional_api_key' | 'subscription'

export type CustomOpenAIProviderScope = 'remote' | 'local'

export interface CustomOpenAIProviderConfig {
  kind: 'openai-compatible'
  scope: CustomOpenAIProviderScope
  name: string
  chatCompletionsEndpoint: string
  usesApiKey: boolean
}

export const modelComponents = ['concierge', 'planner', 'shell-agent', 'sync'] as const
export type ModelComponent = typeof modelComponents[number]

export interface ModelHostProfile {
  /** Optional extension: the root selection is Default; missing overrides inherit it. */
  selectionVersion?: 1
  overrides?: Partial<Record<ModelComponent, ModelHostProfile>>
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
  customProvider?: CustomOpenAIProviderConfig
}

export interface ModelHostMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Cache the provider-facing prefix through this message when supported. */
  cacheControl?: { type: 'ephemeral' }
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
  /** Machtiani model role, kept separate from caller and session identity. */
  role?: string
  sessionId: string
  messages: readonly ModelHostMessage[]
  system?: string
  tools?: readonly ModelHostTool[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  model?: string
  reasoningEffort?: string
  toolChoice?: 'auto' | 'none' | 'required'
  signal?: AbortSignal
}

export type ModelHostAuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string; waitForCompletion?: boolean }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export type ModelHostLoginMode = 'browser' | 'device_code'

export interface ModelHostAuthInteraction {
  signal?: AbortSignal
  prompt(prompt: { type: 'text' | 'manual_code' | 'secret'; message: string; placeholder?: string; signal?: AbortSignal }): Promise<string>
  notify(event: ModelHostAuthEvent): void
}

export interface ModelHostRuntimeDriver {
  authenticated(): Promise<boolean>
  models(): Promise<readonly ModelHostModelInfo[]>
  login(interaction: ModelHostAuthInteraction, mode?: ModelHostLoginMode): Promise<void>
  logout(): Promise<void>
  generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent>
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
  | 'RUNTIME_UNAVAILABLE'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'CANCELLED'
  | 'UPSTREAM_CHANGED'
  | 'INVALID_REQUEST'
  | 'INTERNAL'
  | 'TRANSIENT_ERROR'
  | 'EMPTY_RESPONSE'

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

export const CUSTOM_OPENAI_REMOTE_PROVIDER = 'custom-openai-remote'
export const CUSTOM_OPENAI_LOCAL_PROVIDER = 'custom-openai-local'

export interface ApiKeyProviderDefinition {
  id: 'openrouter' | 'deepseek' | 'openai' | typeof CUSTOM_OPENAI_REMOTE_PROVIDER | typeof CUSTOM_OPENAI_LOCAL_PROVIDER
  name: string
  variable: 'OPENROUTER_API_KEY' | 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY' | 'MACHTIANI_CUSTOM_OPENAI_REMOTE_API_KEY' | 'MACHTIANI_CUSTOM_OPENAI_LOCAL_API_KEY'
}

export const API_KEY_PROVIDERS: readonly ApiKeyProviderDefinition[] = [
  { id: 'openrouter', name: 'OpenRouter', variable: 'OPENROUTER_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', variable: 'DEEPSEEK_API_KEY' },
  { id: 'openai', name: 'OpenAI API', variable: 'OPENAI_API_KEY' },
  { id: CUSTOM_OPENAI_REMOTE_PROVIDER, name: 'Custom OpenAI-compatible provider (remote)', variable: 'MACHTIANI_CUSTOM_OPENAI_REMOTE_API_KEY' },
  { id: CUSTOM_OPENAI_LOCAL_PROVIDER, name: 'Custom OpenAI-compatible provider (local)', variable: 'MACHTIANI_CUSTOM_OPENAI_LOCAL_API_KEY' },
]

function expectedCustomScope(provider: string): CustomOpenAIProviderScope | undefined {
  if (provider === CUSTOM_OPENAI_REMOTE_PROVIDER) return 'remote'
  if (provider === CUSTOM_OPENAI_LOCAL_PROVIDER) return 'local'
  return undefined
}

/** Validate and normalize the exact Chat Completions URL supplied by a user. */
export function validateCustomOpenAIEndpoint(value: string, scope: CustomOpenAIProviderScope): string {
  if (value !== value.trim() || value.length > 4096) throw new ModelHostError('INVALID_REQUEST', 'The Chat Completions endpoint is not a valid single URL.')
  let endpoint: URL
  try { endpoint = new URL(value) } catch { throw new ModelHostError('INVALID_REQUEST', 'Enter a complete Chat Completions URL, such as https://provider.example/v1/chat/completions.') }
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new ModelHostError('INVALID_REQUEST', 'The endpoint must not contain credentials, query parameters, or a fragment.')
  }
  const hostname = endpoint.hostname.toLocaleLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (scope === 'remote') {
    if (endpoint.protocol !== 'https:') throw new ModelHostError('INVALID_REQUEST', 'Remote custom providers require an HTTPS endpoint.')
    if (loopback) throw new ModelHostError('INVALID_REQUEST', 'Choose the local custom-provider option for a loopback endpoint.')
  } else {
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new ModelHostError('INVALID_REQUEST', 'Local custom providers require an HTTP or HTTPS endpoint.')
    if (!loopback) throw new ModelHostError('INVALID_REQUEST', 'Local custom providers must use localhost, 127.0.0.1, or [::1].')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '')
  if (!endpoint.pathname.endsWith('/chat/completions')) {
    throw new ModelHostError('INVALID_REQUEST', 'Enter the complete Chat Completions endpoint ending in /chat/completions.')
  }
  return endpoint.toString()
}

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
  await protectPrivatePath(path, 0o700)
}

async function privateFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || !owned || !await hasPrivatePermissions(path)) {
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
    await protectPrivatePath(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function serializeProviderEnvironment(values: Map<string, string>): string {
  const supported = new Set(API_KEY_PROVIDERS.map(candidate => candidate.variable))
  // backends.env is also owned by CredentialFileAdapter. Its custom backend
  // references must survive assistant setup retries and assistant sign-out.
  const backendVariable = /^MACHTIANI_BACKEND_[A-Z0-9_]{1,40}_[A-F0-9]{16}_API_KEY$/u
  const unknown = [...values.keys()].filter(name => !supported.has(name as ApiKeyProviderDefinition['variable']) && !backendVariable.test(name))
  if (unknown.length > 0) throw new ModelHostError('INVALID_REQUEST', `The provider environment contains unsupported assignments: ${unknown.join(', ')}`)
  return [...values].map(([name, value]) => `${name}=${value}\n`).join('')
}

export async function writeApiKeyCredential(path: string, provider: string, key: string): Promise<void> {
  const definition = providerDefinition(provider)
  if (!validCredential(key)) throw new ModelHostError('INVALID_REQUEST', 'The API key must be one nonempty line without whitespace.')
  const values = parseEnvironment(await privateFile(path))
  values.set(definition.variable, key)
  await writePrivate(path, serializeProviderEnvironment(values))
}

export async function removeApiKeyCredential(path: string, provider: string): Promise<void> {
  const definition = providerDefinition(provider)
  const values = parseEnvironment(await privateFile(path))
  values.delete(definition.variable)
  await writePrivate(path, serializeProviderEnvironment(values))
}

export async function readApiKeyCredential(path: string, provider: string): Promise<string | undefined> {
  const definition = providerDefinition(provider)
  const value = parseEnvironment(await privateFile(path)).get(definition.variable)
  if (value === undefined || value === '') return undefined
  if (!validCredential(value)) throw new ModelHostError('AUTH_REQUIRED', `The saved ${definition.name} API key is invalid. Run machtiani auth login.`)
  return value
}

/** Whole-profile overrides keep provider, credentials, model and reasoning together. */
export function effectiveModelProfile(settings: ModelHostProfile, component: ModelComponent, oneRun?: ModelHostProfile): ModelHostProfile {
  const { selectionVersion: _version, overrides: _overrides, ...profile } = oneRun ?? settings.overrides?.[component] ?? settings
  validateProfile(profile)
  return profile
}

/** Generated aliases carry selectors, never stale copies of model/reasoning defaults. */
export function modelComponentSelector(component: ModelComponent): string { return `@machtiani/${component}` }

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

export function validateProfile(value: unknown): asserts value is ModelHostProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ModelHostError('INVALID_REQUEST', 'The shared model profile is invalid.')
  const profile = value as Partial<ModelHostProfile>
  if (profile.version !== 1 || typeof profile.driver !== 'string' || typeof profile.provider !== 'string' ||
    (profile.authMethod !== 'api_key' && profile.authMethod !== 'optional_api_key' && profile.authMethod !== 'subscription') || typeof profile.model !== 'string' || profile.model === '') {
    throw new ModelHostError('INVALID_REQUEST', 'The shared model profile is invalid.')
  }
  if (profile.selectionVersion !== undefined && profile.selectionVersion !== 1) throw new ModelHostError('INVALID_REQUEST', 'Unsupported model selection version.')
  if (profile.overrides !== undefined) {
    if (profile.selectionVersion !== 1 || !profile.overrides || typeof profile.overrides !== 'object' || Array.isArray(profile.overrides)) throw new ModelHostError('INVALID_REQUEST', 'Invalid model overrides.')
    for (const [component, override] of Object.entries(profile.overrides)) {
      if (!modelComponents.includes(component as ModelComponent) || !override || typeof override !== 'object' || override.selectionVersion !== undefined || override.overrides !== undefined) throw new ModelHostError('INVALID_REQUEST', 'Invalid model component override.')
      validateProfile(override)
    }
  }
  if (profile.reasoningEffort !== undefined && (typeof profile.reasoningEffort !== 'string' || profile.reasoningEffort.trim() === '' || /[\r\n\0]/u.test(profile.reasoningEffort))) {
    throw new ModelHostError('INVALID_REQUEST', 'The reasoning level in the shared model profile is invalid.')
  }
  if (profile.authMethod === 'api_key') {
    const expected = providerDefinition(profile.provider)
    if (profile.driver !== 'pi-ai' || profile.credential?.kind !== 'environment-file' ||
      profile.credential.variable !== expected.variable || typeof profile.credential.path !== 'string' || profile.credential.path === '') {
      throw new ModelHostError('INVALID_REQUEST', 'The API-key model profile has an invalid credential reference.')
    }
    if (profile.customProvider !== undefined) throw new ModelHostError('INVALID_REQUEST', 'A built-in provider profile cannot contain custom endpoint settings.')
  } else if (profile.authMethod === 'optional_api_key') {
    const scope = expectedCustomScope(profile.provider)
    const custom = profile.customProvider
    if (profile.driver !== 'openai-compatible' || scope === undefined || custom?.kind !== 'openai-compatible' || custom.scope !== scope ||
      typeof custom.name !== 'string' || custom.name.trim() === '' || custom.name !== custom.name.trim() || /[\r\n\0]/u.test(custom.name) ||
      typeof custom.usesApiKey !== 'boolean') {
      throw new ModelHostError('INVALID_REQUEST', 'The custom OpenAI-compatible model profile is invalid.')
    }
    validateCustomOpenAIEndpoint(custom.chatCompletionsEndpoint, scope)
    if (custom.usesApiKey && profile.credential === undefined) {
      throw new ModelHostError('INVALID_REQUEST', 'The custom provider is configured to use an API key, but its credential reference is missing.')
    }
    if (!custom.usesApiKey && profile.credential !== undefined) {
      throw new ModelHostError('INVALID_REQUEST', 'The keyless custom provider must not contain a credential reference.')
    }
    if (profile.credential !== undefined) {
      const expected = providerDefinition(profile.provider)
      if (profile.credential.kind !== 'environment-file' || profile.credential.variable !== expected.variable ||
        typeof profile.credential.path !== 'string' || profile.credential.path === '') {
        throw new ModelHostError('INVALID_REQUEST', 'The custom provider profile has an invalid credential reference.')
      }
    }
  } else {
    const combinations = new Map([
      ['openai-codex', 'openai-codex-app-server'],
      ['github-copilot', 'github-copilot-sdk'],
      ['anthropic-claude', 'anthropic-claude-agent-sdk'],
    ])
    if (combinations.get(profile.provider) !== profile.driver || typeof profile.runtimeProfile !== 'string' || profile.runtimeProfile === '') {
      throw new ModelHostError('INVALID_REQUEST', 'The subscription model profile has an invalid official-runtime reference.')
    }
    if (profile.customProvider !== undefined) throw new ModelHostError('INVALID_REQUEST', 'A subscription profile cannot contain custom endpoint settings.')
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

function endpointBaseUrl(chatCompletionsEndpoint: string): string {
  return chatCompletionsEndpoint.slice(0, -'/chat/completions'.length)
}

function customModels(profile: ModelHostProfile): Models {
  const custom = profile.customProvider!
  const normalizedEndpoint = validateCustomOpenAIEndpoint(custom.chatCompletionsEndpoint, custom.scope)
  const credentialStore = new FileCredentialStore(profile)
  const models = createModels({ credentials: credentialStore })
  const model: Model<'openai-completions'> = {
    id: profile.model,
    name: profile.model,
    api: 'openai-completions',
    provider: profile.provider as Model<'openai-completions'>['provider'],
    baseUrl: endpointBaseUrl(normalizedEndpoint),
    reasoning: profile.reasoningEffort !== undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
    compat: {
      supportsUsageInStreaming: false,
      maxTokensField: 'max_tokens',
      ...(profile.reasoningEffort === undefined ? {} : { supportsReasoningEffort: true }),
    },
  }
  models.setProvider(createProvider({
    id: profile.provider,
    name: custom.name,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: `${custom.name} API key`,
        resolve: async () => {
          if (profile.credential === undefined) {
            return { auth: { apiKey: 'unused', headers: { Authorization: null } }, source: 'No API key' }
          }
          const key = await readApiKeyCredential(profile.credential.path, profile.provider)
          return key === undefined ? undefined : { auth: { apiKey: key }, source: profile.credential.variable }
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  }))
  return models
}

function hostModels(profile: ModelHostProfile): Models {
  if (profile.authMethod === 'optional_api_key') return customModels(profile)
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
  if (/(?:auth|oauth|token|credential).*(?:expired|revoked)|(?:expired|revoked).*(?:auth|oauth|token|credential)/iu.test(message)) return new ModelHostError('AUTH_EXPIRED', 'The model provider sign-in has expired or was revoked.')
  if (/401|403|auth|credential|api key/iu.test(message)) return new ModelHostError('AUTH_REQUIRED', 'The model provider needs authentication. Run machtiani auth login.')
  if (/429|rate.?limit/iu.test(message)) return new ModelHostError('RATE_LIMITED', 'The model provider is temporarily rate-limited.')
  if (/quota|credit|billing/iu.test(message)) return new ModelHostError('QUOTA_EXHAUSTED', 'The model provider account has no available usage.')
  if (/model.*(?:not found|unavailable)|404/iu.test(message)) return new ModelHostError('MODEL_UNAVAILABLE', 'The selected model is no longer available.')
  return new ModelHostError('INTERNAL', 'The model provider request failed.')
}

export class ModelHost {
  constructor(readonly profile: ModelHostProfile) { validateProfile(profile) }

  static async open(profilePath: string, component?: ModelComponent): Promise<ModelHost> {
    const profile = await loadModelHostProfile(profilePath)
    return new ModelHost(component === undefined ? profile : effectiveModelProfile(profile, component))
  }

  async authenticated(): Promise<boolean> {
    if (this.profile.authMethod === 'subscription') return await subscriptionDriver(this.profile).authenticated()
    if (this.profile.authMethod === 'optional_api_key' && this.profile.credential === undefined) return true
    if (this.profile.credential === undefined) return false
    return await readApiKeyCredential(this.profile.credential.path, this.profile.provider) !== undefined
  }

  async models(): Promise<readonly ModelHostModelInfo[]> {
    if (this.profile.authMethod === 'subscription') return await subscriptionDriver(this.profile).models()
    if (this.profile.authMethod === 'optional_api_key') return [{ id: this.profile.model, name: this.profile.model, reasoningEfforts: this.profile.reasoningEffort === undefined ? [] : [this.profile.reasoningEffort] }]
    return apiKeyModels(this.profile.provider)
  }

  async login(interaction: ModelHostAuthInteraction, mode?: ModelHostLoginMode): Promise<void> {
    if (this.profile.authMethod !== 'subscription') throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'API-key sign-in is collected through the secure installer field.')
    await subscriptionDriver(this.profile).login(interaction, mode)
  }

  async logout(): Promise<void> {
    if (this.profile.authMethod === 'subscription') { await subscriptionDriver(this.profile).logout(); return }
    if (this.profile.credential !== undefined) await removeApiKeyCredential(this.profile.credential.path, this.profile.provider)
  }

  async * generate(request: ModelHostGenerateRequest): AsyncIterable<ModelHostEvent> {
    if (request.sessionId.trim() === '' || request.caller.trim() === '') throw new ModelHostError('INVALID_REQUEST', 'Generation requires caller and session identity.')
    if (this.profile.authMethod === 'subscription') {
      try { yield * subscriptionDriver(this.profile).generate(request) }
      catch (error) { throw error instanceof ModelHostError ? error : mappedError(error instanceof Error ? error.message : String(error)) }
      return
    }
    if (!await this.authenticated()) throw new ModelHostError('AUTH_REQUIRED', `Sign in to ${providerDefinition(this.profile.provider).name} before using this model.`)
    const models = hostModels(this.profile)
    const modelId = request.model ?? this.profile.model
    const model = models.getModel(this.profile.provider, modelId)
    if (model === undefined) throw new ModelHostError('MODEL_UNAVAILABLE', `The selected model ${modelId} is not available from this provider configuration.`)
    const toolNames = new Map<string, string>()
    for (const message of request.messages) for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name)
    const prompt = systemPrompt(request)
    const context = {
      ...(prompt === undefined ? {} : { systemPrompt: prompt }),
      messages: piMessages(request.messages),
      ...(request.tools === undefined ? {} : { tools: request.tools as unknown as Tool[] }),
    }
    // pi-ai silently clamps output to one token when its context estimate
    // exceeds the window. Report this before streaming so callers can shrink
    // their prompt instead of accepting an empty, length-limited completion.
    const outputTokens = request.maxTokens ?? model.maxTokens
    if (clampMaxTokensToContext(model, context, outputTokens) < outputTokens) {
      throw new ModelHostError('CONTEXT_LENGTH_EXCEEDED', 'The prompt leaves insufficient context space for the model response. Reduce the input and retry.')
    }
    const options = {
      ...(request.reasoningEffort ?? this.profile.reasoningEffort) === undefined ? {} : { reasoning: (request.reasoningEffort ?? this.profile.reasoningEffort) as ThinkingLevel },
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(request.stop === undefined ? {} : { stopSequences: [...request.stop] }),
      // Chat Completions supports "required" although pi-ai's provider-neutral
      // ToolChoice union currently exposes only "auto" and "none".
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice as never }),
      ...(this.profile.authMethod !== 'optional_api_key' ? {} : {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const response = await fetch(input, { ...init, redirect: 'manual' })
          if (response.status >= 300 && response.status < 400) throw new Error('Custom provider redirects are not followed.')
          return response
        },
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    try {
      for await (const event of models.streamSimple(model, context, options)) {
        const mapped = mapPiEvent(event, toolNames)
        for (const item of mapped) yield item
      }
    } catch (error) {
      if (error instanceof ModelHostError) throw error
      throw mappedError(error instanceof Error ? error.message : String(error))
    }
  }
}

function compatibilityFailure(error: unknown): ModelHostError {
  if (error instanceof ModelHostError) {
    if (error.code === 'AUTH_REQUIRED') return new ModelHostError('AUTH_REQUIRED', 'The provider rejected the API key, or a required API key was not supplied.')
    if (error.code === 'MODEL_UNAVAILABLE') return new ModelHostError('MODEL_UNAVAILABLE', 'The endpoint did not accept that model name. Check the provider’s canonical model documentation.')
    if (error.code === 'RATE_LIMITED' || error.code === 'QUOTA_EXHAUSTED') return error
  }
  return new ModelHostError('UNSUPPORTED_CAPABILITY', 'The endpoint did not complete the compatibility test. Check that it is reachable and implements streaming Chat Completions with tools.')
}

/**
 * Prove the exact custom endpoint, credentials, model, and optional reasoning
 * setting can stream a tool call and continue after its result.
 */
export async function verifyCustomOpenAIProfile(profile: ModelHostProfile, signal?: AbortSignal): Promise<void> {
  validateProfile(profile)
  if (profile.authMethod !== 'optional_api_key') throw new ModelHostError('INVALID_REQUEST', 'Only custom OpenAI-compatible profiles use this compatibility test.')
  const host = new ModelHost(profile)
  const sessionId = `compatibility-${randomUUID()}`
  const timeout = AbortSignal.timeout(120_000)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const firstMessages: ModelHostMessage[] = [{
    role: 'user',
    content: 'Call the compatibility_echo tool exactly once with value "ready". Do not answer in text before calling it.',
  }]
  let toolCall: { id: string; name: string; arguments: string } | undefined
  let firstFinished = false
  try {
    for await (const event of host.generate({
      caller: 'installer-compatibility-test',
      sessionId,
      messages: firstMessages,
      tools: [{
        name: 'compatibility_echo',
        description: 'Return a small test value to prove tool calling works.',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      }],
      toolChoice: 'required',
      maxTokens: 256,
      signal: requestSignal,
    })) {
      if (event.type === 'tool-end' && event.name === 'compatibility_echo') toolCall = { id: event.id, name: event.name, arguments: event.arguments }
      if (event.type === 'finish' && event.reason === 'tool-calls') firstFinished = true
    }
  } catch (error) { throw compatibilityFailure(error) }
  if (toolCall === undefined || !firstFinished) {
    throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'The model streamed a response but did not make the required tool call. Choose a model with Chat Completions tool support.')
  }

  let continuation = ''
  let continuedNormally = false
  try {
    for await (const event of host.generate({
      caller: 'installer-compatibility-test',
      sessionId,
      messages: [
        ...firstMessages,
        { role: 'assistant', content: '', toolCalls: [toolCall] },
        { role: 'tool', content: '{"value":"ready"}', toolCallId: toolCall.id, toolName: toolCall.name },
      ],
      maxTokens: 128,
      signal: requestSignal,
    })) {
      if (event.type === 'text-delta') continuation += event.text
      if (event.type === 'finish' && event.reason === 'stop') continuedNormally = true
    }
  } catch (error) { throw compatibilityFailure(error) }
  if (continuation.trim() === '' || !continuedNormally) {
    throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'The model accepted a tool call but did not continue normally after the tool result.')
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

type HostSession = Pick<ModelHost, 'authenticated' | 'generate' | 'models' | 'profile' | 'login' | 'logout'>

export async function serveModelHost(
  profilePath: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  openHost: (path: string, component?: ModelComponent) => Promise<HostSession> = ModelHost.open,
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
      const generation = request.method === 'generation/start' ? request.params as ModelHostGenerateRequest : undefined
      const component = modelComponents.find(value => generation?.model === modelComponentSelector(value))
      const host = await openHost(profilePath, component)
      if (request.method === 'initialize') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { protocolVersion: MODEL_HOST_PROTOCOL_VERSION, capabilities: ['models', 'auth', 'generate', 'stream', 'cancel', 'usage'] } })
      else if (request.method === 'models/list') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { provider: host.profile.provider, models: await host.models() } })
      else if (request.method === 'auth/status') send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { authenticated: await host.authenticated(), method: host.profile.authMethod } })
      else if (request.method === 'auth/login') {
        if (host.profile.authMethod !== 'subscription') throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'API-key sign-in uses the installer secure field.')
        const mode = (request.params as { mode?: unknown } | undefined)?.mode
        if (mode !== undefined && mode !== 'browser' && mode !== 'device_code') {
          throw new ModelHostError('INVALID_REQUEST', 'Authentication mode must be browser or device_code.')
        }
        await host.login({
          prompt: async () => { throw new ModelHostError('UNSUPPORTED_CAPABILITY', 'This sign-in requires the interactive Machtiani Installer.') },
          notify: event => send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, event: { type: 'auth', auth: event } }),
        }, mode)
        send({ v: MODEL_HOST_PROTOCOL_VERSION, id: request.id, result: { authenticated: true } })
      }
      else if (request.method === 'auth/logout') {
        await host.logout()
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
        if (component !== undefined) delete params.model
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
