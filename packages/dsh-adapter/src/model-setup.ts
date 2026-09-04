import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  apiKeyModels,
  apiKeyProviders,
  readApiKeyCredential,
  writeApiKeyCredential,
} from '@dearmachine/machtiani-model-host'

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

/** API-key provider catalogue and private credential handoff used before DSH starts. */
export class InstallerModelSetup {
  private constructor(
    readonly dshHome: string,
    readonly credentialPath: string,
  ) {}

  static async open(
    dshHome: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: { credentialPath?: string } = {},
  ): Promise<InstallerModelSetup> {
    await ensurePrivateDirectory(dshHome)
    const credentialPath = options.credentialPath ?? join(dshHome, 'backends.env')
    for (const provider of apiKeyProviders()) {
      const ambient = environment[provider.variable]
      if (ambient !== undefined && ambient !== '' && await readApiKeyCredential(credentialPath, provider.id) === undefined) {
        await writeApiKeyCredential(credentialPath, provider.id, ambient)
      }
    }
    return new InstallerModelSetup(dshHome, credentialPath)
  }

  providers(): readonly InstallerProviderOption[] {
    return apiKeyProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      authMethods: [{ id: 'api_key', label: `${provider.name} API key`, subscription: false }],
    }))
  }

  modelsFor(providerId: string): readonly InstallerModelOption[] {
    return apiKeyModels(providerId)
  }

  async isAuthenticated(providerId: string): Promise<boolean> {
    return await readApiKeyCredential(this.credentialPath, providerId) !== undefined
  }

  async authenticate(providerId: string, method: InstallerAuthMethodId, interaction: InstallerAuthInteraction): Promise<void> {
    if (method !== 'api_key' || !this.providers().some(provider => provider.id === providerId)) {
      throw new Error(`${providerId} does not offer the selected authentication method`)
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
