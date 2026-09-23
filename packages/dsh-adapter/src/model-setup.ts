import { protectPrivatePath, hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  API_KEY_PROVIDERS,
  apiKeyModels,
  apiKeyProviders,
  CUSTOM_OPENAI_LOCAL_PROVIDER,
  CUSTOM_OPENAI_REMOTE_PROVIDER,
  ModelHost,
  removeApiKeyCredential,
  readApiKeyCredential,
  subscriptionProviders,
  validateCustomOpenAIEndpoint,
  verifyCustomOpenAIProfile,
  type CustomOpenAIProviderConfig,
  type CustomOpenAIProviderScope,
  type ModelHostProfile,
  writeApiKeyCredential,
} from '@dearmachine/machtiani-model-host'

export type InstallerAuthMethodId = 'api_key' | 'oauth' | 'device_code'

export interface InstallerAuthMethod {
  id: InstallerAuthMethodId
  label: string
  description?: string
  subscription: boolean
}

export interface InstallerProviderOption {
  id: string
  name: string
  authMethods: readonly InstallerAuthMethod[]
  customScope?: CustomOpenAIProviderScope
}

export interface InstallerModelOption {
  id: string
  name: string
  reasoningEfforts: readonly string[]
}

export interface InstallerModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
  customProvider?: CustomOpenAIProviderConfig
}

export type InstallerAuthPrompt =
  | { type: 'text' | 'manual_code'; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: 'secret'; message: string; placeholder?: string; signal?: AbortSignal }
  | {
      type: 'select'
      message: string
      options: readonly { id: string; label: string; description?: string }[]
      signal?: AbortSignal
    }

export type InstallerAuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string; waitForCompletion?: boolean }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export interface InstallerAuthInteraction {
  signal?: AbortSignal
  prompt(prompt: InstallerAuthPrompt): Promise<string>
  notify(event: InstallerAuthEvent): void
}

const selectionFilename = 'installer-model.json'

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned) {
    throw new Error('installer model directory must be an owned regular directory')
  }
  await protectPrivatePath(path, 0o700)
}

/** API-key provider catalogue and private credential handoff used before DSH starts. */
export class InstallerModelSetup {
  private constructor(
    readonly dshHome: string,
    readonly credentialPath: string,
    readonly home: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  static async open(
    dshHome: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: { credentialPath?: string; home?: string } = {},
  ): Promise<InstallerModelSetup> {
    await ensurePrivateDirectory(dshHome)
    const credentialPath = options.credentialPath ?? join(dshHome, 'backends.env')
    for (const provider of apiKeyProviders()) {
      const ambient = environment[provider.variable]
      if (ambient !== undefined && ambient !== '' && await readApiKeyCredential(credentialPath, provider.id) === undefined) {
        await writeApiKeyCredential(credentialPath, provider.id, ambient)
      }
    }
    const home = options.home ?? environment.HOME ?? join(dshHome, 'runtime-home')
    return new InstallerModelSetup(dshHome, credentialPath, home, environment)
  }

  providers(): readonly InstallerProviderOption[] {
    const subscriptions: InstallerProviderOption[] = subscriptionProviders(this.environment).map(provider => ({
        id: provider.id,
        name: provider.name,
        authMethods: provider.id === 'openai-codex'
          ? [
              { id: 'oauth', label: 'Sign in with ChatGPT in your browser', description: 'Best for a local desktop install', subscription: true },
              { id: 'device_code', label: 'Sign in with a device code', description: 'Best for SSH, containers, or headless installs', subscription: true },
            ]
          : [{
              id: 'oauth',
              label: provider.id === 'github-copilot' ? 'Sign in with GitHub' : 'Sign in with Claude',
              subscription: true,
            }],
      }))
    const apiKeys: InstallerProviderOption[] = apiKeyProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      authMethods: [{ id: 'api_key', label: `${provider.name} API key`, subscription: false }],
      }))
    const custom: InstallerProviderOption[] = [
      {
        id: CUSTOM_OPENAI_REMOTE_PROVIDER,
        name: 'Custom OpenAI-compatible provider (remote)',
        authMethods: [],
        customScope: 'remote',
      },
      {
        id: CUSTOM_OPENAI_LOCAL_PROVIDER,
        name: 'Custom OpenAI-compatible provider (local)',
        authMethods: [],
        customScope: 'local',
      },
    ]
    return [...subscriptions, ...apiKeys, ...custom]
  }

  async modelsFor(providerId: string): Promise<readonly InstallerModelOption[]> {
    if (providerId === CUSTOM_OPENAI_REMOTE_PROVIDER || providerId === CUSTOM_OPENAI_LOCAL_PROVIDER) return []
    if (apiKeyProviders().some(provider => provider.id === providerId)) return apiKeyModels(providerId)
    return await new ModelHost(this.profileFor({ provider: providerId, model: 'pending' })).models()
  }

  async isAuthenticated(providerId: string): Promise<boolean> {
    if (providerId === CUSTOM_OPENAI_REMOTE_PROVIDER || providerId === CUSTOM_OPENAI_LOCAL_PROVIDER) return false
    if (apiKeyProviders().some(provider => provider.id === providerId)) return await readApiKeyCredential(this.credentialPath, providerId) !== undefined
    return await new ModelHost(this.profileFor({ provider: providerId, model: 'pending' })).authenticated()
  }

  async authenticate(providerId: string, method: InstallerAuthMethodId, interaction: InstallerAuthInteraction): Promise<void> {
    const selected = this.providers().find(provider => provider.id === providerId)
    if (selected === undefined || !selected.authMethods.some(candidate => candidate.id === method)) {
      throw new Error(`${providerId} does not offer the selected authentication method`)
    }
    if (method === 'oauth' || method === 'device_code') {
      await new ModelHost(this.profileFor({ provider: providerId, model: 'pending' })).login(
        interaction,
        method === 'device_code' ? 'device_code' : 'browser',
      )
      return
    }
    const provider = this.providers().find(candidate => candidate.id === providerId)!
    const key = await interaction.prompt({
      type: 'secret',
      message: `Paste your ${provider.name} API key into the secure field and press Enter. It will be saved once for the installer and Dear Machine, and will never enter the conversation.`,
      ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
    })
    await writeApiKeyCredential(this.credentialPath, providerId, key)
  }

  async close(): Promise<void> {}

  async prepareCustomProvider(selection: InstallerModelSelection, apiKey: string | undefined): Promise<void> {
    const customProvider = selection.customProvider
    const scope = customProvider?.scope
    if (customProvider === undefined || scope === undefined || (selection.provider !== CUSTOM_OPENAI_REMOTE_PROVIDER && selection.provider !== CUSTOM_OPENAI_LOCAL_PROVIDER)) {
      throw new Error('invalid custom provider selection')
    }
    if (selection.customProvider?.usesApiKey === true && apiKey === undefined) throw new Error('the custom provider API key is missing')
    if (selection.customProvider?.usesApiKey === false && apiKey !== undefined) throw new Error('a keyless custom provider cannot receive an API key')
    if (apiKey === undefined) await removeApiKeyCredential(this.credentialPath, selection.provider)
    else await writeApiKeyCredential(this.credentialPath, selection.provider, apiKey)
    validateCustomOpenAIEndpoint(customProvider.chatCompletionsEndpoint, scope)
  }

  async verifyCustomProvider(selection: InstallerModelSelection, apiKey: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.prepareCustomProvider(selection, apiKey)
    const customProvider = selection.customProvider!
    const scope = customProvider.scope
    await verifyCustomOpenAIProfile(this.profileFor({
      ...selection,
      customProvider: {
        ...customProvider,
        chatCompletionsEndpoint: validateCustomOpenAIEndpoint(customProvider.chatCompletionsEndpoint, scope),
      },
    }), signal)
  }

  /** Recheck a saved endpoint using its private credential reference, without rewriting credentials. */
  async verifySavedCustomProvider(selection: InstallerModelSelection, signal?: AbortSignal): Promise<void> {
    if (selection.customProvider === undefined) throw new Error('custom provider settings are missing')
    await verifyCustomOpenAIProfile(this.profileFor(selection), signal)
  }

  profileFor(selection: InstallerModelSelection): ModelHostProfile {
    if (selection.provider === CUSTOM_OPENAI_REMOTE_PROVIDER || selection.provider === CUSTOM_OPENAI_LOCAL_PROVIDER) {
      const definition = API_KEY_PROVIDERS.find(provider => provider.id === selection.provider)!
      const customProvider = selection.customProvider
      if (customProvider === undefined) throw new Error('custom provider settings are missing')
      const credential = customProvider.usesApiKey ? {
        kind: 'environment-file' as const,
        path: this.credentialPath,
        variable: definition.variable,
      } : undefined
      return {
        version: 1,
        driver: 'openai-compatible',
        provider: selection.provider,
        authMethod: 'optional_api_key',
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        ...(credential === undefined ? {} : { credential }),
        customProvider: {
          ...customProvider,
          chatCompletionsEndpoint: validateCustomOpenAIEndpoint(customProvider.chatCompletionsEndpoint, customProvider.scope),
        },
      }
    }
    const api = apiKeyProviders().find(provider => provider.id === selection.provider)
    if (api !== undefined) return {
      version: 1, driver: 'pi-ai', provider: selection.provider, authMethod: 'api_key', model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      credential: { kind: 'environment-file', path: this.credentialPath, variable: api.variable },
    }
    const subscription = subscriptionProviders(this.environment).find(provider => provider.id === selection.provider)
    if (subscription === undefined) throw new Error(`unsupported shared model provider: ${selection.provider}`)
    const runtimeProfile = selection.provider === 'openai-codex'
      ? (this.environment.MACHTIANI_CODEX_HOME ?? join(this.home, '.config', 'machtiani', 'codex'))
      : selection.provider === 'github-copilot'
        ? (this.environment.COPILOT_HOME ?? join(this.home, '.copilot'))
        : (this.environment.CLAUDE_CONFIG_DIR ?? join(this.home, '.config', 'machtiani', 'claude'))
    return {
      version: 1, driver: subscription.driver, provider: selection.provider, authMethod: 'subscription', model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }), runtimeProfile,
    }
  }
}

function parsedSelection(value: unknown): InstallerModelSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || candidate.provider === '' || typeof candidate.model !== 'string' || candidate.model === '') return undefined
  if (candidate.reasoningEffort !== undefined && (typeof candidate.reasoningEffort !== 'string' || candidate.reasoningEffort === '')) return undefined
  let customProvider: CustomOpenAIProviderConfig | undefined
  if (candidate.customProvider !== undefined) {
    if (typeof candidate.customProvider !== 'object' || candidate.customProvider === null || Array.isArray(candidate.customProvider)) return undefined
    const custom = candidate.customProvider as Record<string, unknown>
    if (custom.kind !== 'openai-compatible' || (custom.scope !== 'remote' && custom.scope !== 'local') ||
      typeof custom.name !== 'string' || custom.name.trim() === '' || typeof custom.chatCompletionsEndpoint !== 'string' ||
      typeof custom.usesApiKey !== 'boolean') return undefined
    try {
      customProvider = {
        kind: 'openai-compatible',
        scope: custom.scope,
        name: custom.name,
        chatCompletionsEndpoint: validateCustomOpenAIEndpoint(custom.chatCompletionsEndpoint, custom.scope),
        usesApiKey: custom.usesApiKey,
      }
    } catch { return undefined }
  }
  const expectedScope = candidate.provider === CUSTOM_OPENAI_REMOTE_PROVIDER
    ? 'remote'
    : candidate.provider === CUSTOM_OPENAI_LOCAL_PROVIDER ? 'local' : undefined
  if (expectedScope === undefined ? customProvider !== undefined : customProvider?.scope !== expectedScope) return undefined
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
    ...(customProvider === undefined ? {} : { customProvider }),
  }
}

export async function loadInstallerModelSelection(dshHome: string): Promise<InstallerModelSelection | undefined> {
  const filename = join(dshHome, selectionFilename)
  try {
    const metadata = await lstat(filename)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || !await hasPrivatePermissions(filename) || !owned) {
      throw new Error('installer model configuration must be a private regular file')
    }
    return parsedSelection(JSON.parse(await readFile(filename, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function saveInstallerModelSelection(dshHome: string, selection: InstallerModelSelection): Promise<void> {
  const parsed = parsedSelection(selection)
  if (parsed === undefined) throw new Error('invalid installer model selection')
  await ensurePrivateDirectory(dshHome)
  const filename = join(dshHome, selectionFilename)
  const temporary = join(dshHome, `.installer-model-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await protectPrivatePath(temporary, 0o600)
    await rename(temporary, filename)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function isKnownInstallerModelSelection(
  setup: Pick<InstallerModelSetup, 'providers' | 'modelsFor'>,
  selection: InstallerModelSelection | undefined,
): Promise<boolean> {
  const parsed = parsedSelection(selection)
  if (parsed === undefined || !setup.providers().some(provider => provider.id === parsed.provider)) return false
  const customScope = setup.providers().find(provider => provider.id === parsed.provider)?.customScope
  if (customScope !== undefined) {
    return parsed.customProvider?.scope === customScope
  }
  const model = (await setup.modelsFor(parsed.provider)).find(candidate => candidate.id === parsed.model)
  if (model === undefined) return false
  return parsed.reasoningEffort === undefined || model.reasoningEfforts.includes(parsed.reasoningEffort)
}
