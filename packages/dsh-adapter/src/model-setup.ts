import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  getSupportedThinkingLevels,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type AuthType,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Models,
} from '@earendil-works/pi-ai'

export type InstallerAuthMethodId = 'api_key' | 'oauth'

export interface InstallerAuthMethod {
  id: InstallerAuthMethodId
  label: string
  subscription: boolean
}

export interface InstallerProviderOption {
  id: string
  name: string
  authMethods: readonly InstallerAuthMethod[]
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
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export interface InstallerAuthInteraction {
  signal?: AbortSignal
  prompt(prompt: InstallerAuthPrompt): Promise<string>
  notify(event: InstallerAuthEvent): void
}

const preferredProviders = [
  'openrouter',
  'deepseek',
  'anthropic',
  'openai-codex',
  'openai',
  'google',
  'github-copilot',
  'xai',
] as const

const selectionFilename = 'installer-model.json'

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned) {
    throw new Error('installer model directory must be an owned regular directory')
  }
  await chmod(path, 0o700)
}

function providerOrder(id: string): number {
  const preferred = preferredProviders.indexOf(id as typeof preferredProviders[number])
  return preferred < 0 ? preferredProviders.length : preferred
}

function credentialFromRecord(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    }
  }
  return record.payload as Credential
}

function recordFromCredential(credential: Credential): CredentialRecord {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    }
  }
  return { kind: 'grant', payload: JSON.parse(JSON.stringify(credential)) as unknown }
}

function credentialStore(ctx: Context): CredentialStore {
  return {
    async read(providerId) {
      return credentialFromRecord(await ctx.credentials.readRecord(recordKeyFor(providerId)))
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const records = await ctx.credentials.listRecords()
      return records.flatMap(record => {
        const prefix = 'llm-pi-ai/'
        const key = String(record.key)
        if (!key.startsWith(prefix)) return []
        return [{ providerId: key.slice(prefix.length), type: record.kind === 'api-key' ? 'api_key' as const : 'oauth' as const }]
      })
    },
    async modify(providerId, mutate) {
      return credentialFromRecord(await ctx.credentials.modifyRecord(recordKeyFor(providerId), async current => {
        const next = await mutate(credentialFromRecord(current))
        return next === undefined ? undefined : recordFromCredential(next)
      }))
    },
    async delete(providerId) {
      await ctx.credentials.deleteRecord(recordKeyFor(providerId))
    },
  }
}

function expanded(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function authContext(environment: NodeJS.ProcessEnv) {
  return {
    env: async (name: string) => {
      const value = environment[name]
      return value === undefined || value === '' ? undefined : value
    },
    fileExists: async (path: string) => {
      try {
        await access(expanded(path), constants.F_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

function authMethods(models: Models, providerId: string): InstallerAuthMethod[] {
  const auth = models.getProvider(providerId)?.auth
  if (auth === undefined) return []
  return [
    ...(auth.oauth === undefined ? [] : [{
      id: 'oauth' as const,
      label: auth.oauth.loginLabel ?? auth.oauth.name,
      subscription: auth.oauth.isSubscription === true,
    }]),
    ...(auth.apiKey?.login === undefined ? [] : [{
      id: 'api_key' as const,
      label: auth.apiKey.name,
      subscription: false,
    }]),
  ]
}

function toInstallerPrompt(prompt: AuthPrompt): InstallerAuthPrompt {
  if (prompt.type === 'select') return {
    type: 'select',
    message: prompt.message,
    options: prompt.options,
    ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
  }
}

function toInstallerEvent(event: AuthEvent): InstallerAuthEvent {
  return { ...event }
}

/** DSH-owned provider catalog and credential store exposed through installer-safe metadata. */
export class InstallerModelSetup {
  private constructor(
    private readonly ctx: Context,
    private readonly models: Models,
    readonly dshHome: string,
  ) {}

  static async open(dshHome: string, environment: NodeJS.ProcessEnv = process.env): Promise<InstallerModelSetup> {
    await ensurePrivateDirectory(dshHome)
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, {
        path: join(dshHome, '.credentials.yaml'),
        watch: false,
      })
      return new InstallerModelSetup(ctx, builtinModels({
        credentials: credentialStore(ctx),
        authContext: authContext(environment),
      }), dshHome)
    } catch (error) {
      await ctx.fiber.dispose().catch(() => {})
      throw error
    }
  }

  providers(): readonly InstallerProviderOption[] {
    return this.models.getProviders()
      .filter(provider => provider.getModels().length > 0 && authMethods(this.models, provider.id).length > 0)
      .map(provider => ({ id: provider.id, name: provider.name, authMethods: authMethods(this.models, provider.id) }))
      .sort((left, right) => providerOrder(left.id) - providerOrder(right.id) || left.name.localeCompare(right.name))
  }

  modelsFor(providerId: string): readonly InstallerModelOption[] {
    return this.models.getModels(providerId).map(model => ({
      id: model.id,
      name: model.name,
      reasoningEfforts: getSupportedThinkingLevels(model),
    }))
  }

  async isAuthenticated(providerId: string): Promise<boolean> {
    return await this.models.checkAuth(providerId) !== undefined
  }

  async authenticate(providerId: string, method: InstallerAuthMethodId, interaction: InstallerAuthInteraction): Promise<void> {
    const offered = authMethods(this.models, providerId)
    if (!offered.some(candidate => candidate.id === method)) {
      throw new Error(`${providerId} does not offer the selected authentication method`)
    }
    const bridged: AuthInteraction = {
      ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
      prompt: prompt => interaction.prompt(toInstallerPrompt(prompt)),
      notify: event => { interaction.notify(toInstallerEvent(event)) },
    }
    await this.models.login(providerId, method as AuthType, bridged)
  }

  async close(): Promise<void> {
    await this.ctx.fiber.dispose()
  }
}

function parsedSelection(value: unknown): InstallerModelSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || candidate.provider === '' || typeof candidate.model !== 'string' || candidate.model === '') return undefined
  if (candidate.reasoningEffort !== undefined && (typeof candidate.reasoningEffort !== 'string' || candidate.reasoningEffort === '')) return undefined
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
  }
}

export async function loadInstallerModelSelection(dshHome: string): Promise<InstallerModelSelection | undefined> {
  const filename = join(dshHome, selectionFilename)
  try {
    const metadata = await lstat(filename)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !owned) {
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
    await chmod(temporary, 0o600)
    await rename(temporary, filename)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export function isKnownInstallerModelSelection(
  setup: Pick<InstallerModelSetup, 'providers' | 'modelsFor'>,
  selection: InstallerModelSelection | undefined,
): selection is InstallerModelSelection {
  if (selection === undefined || !setup.providers().some(provider => provider.id === selection.provider)) return false
  const model = setup.modelsFor(selection.provider).find(candidate => candidate.id === selection.model)
  if (model === undefined) return false
  return selection.reasoningEffort === undefined || model.reasoningEfforts.includes(selection.reasoningEffort)
}
