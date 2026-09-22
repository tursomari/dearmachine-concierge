import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { loadDistribution, NativeProductInstaller, type InstalledProducts } from '@dearmachine/machtiani-installer-products'
import type { ReadyInstallationSelection } from '@dearmachine/machtiani-installer-workflow'
import { InstallerModelSetup } from '@dearmachine/machtiani-installer-dsh-adapter'
import { saveModelHostProfile, validateCustomOpenAIEndpoint, type CustomOpenAIProviderConfig } from '@dearmachine/machtiani-model-host'
import { acquireInstallerLock } from './lock.ts'
import { defaultInstallerPaths, validatedSourceRoot } from './index.ts'
import { resolveSourceReference, saveSourceReference } from './source-reference.ts'

const selectionKeys = ['authorizedSender', 'backend', 'detectedBackends', 'model', 'provider', 'transport'] as const
export type HeadlessSelection = ReadyInstallationSelection & { customProvider?: CustomOpenAIProviderConfig }

const backendKeys = ['executable', 'id', 'name', 'status', 'summary'] as const

export interface HeadlessInvocation { sourceRoot: string; selectionFile: string; existingInboxId?: string; reasoningEffort?: string }

export function parseHeadlessArguments(args: readonly string[]): HeadlessInvocation {
  if (args.length === 4 && args[0] === '--source-root' && args[1] !== '' && args[2] === '--selection-file' && args[3] !== '') {
    return { sourceRoot: args[1]!, selectionFile: args[3]! }
  }
  if (args.length === 6 && args[0] === '--source-root' && args[1] !== '' && args[2] === '--selection-file' && args[3] !== '' &&
    args[4] === '--existing-inbox-id' && args[5] !== '') {
    return { sourceRoot: args[1]!, selectionFile: args[3]!, existingInboxId: args[5]! }
  }
  if (args.length === 8 && args[0] === '--source-root' && args[1] !== '' && args[2] === '--selection-file' && args[3] !== '' &&
    args[4] === '--existing-inbox-id' && args[5] !== '' && args[6] === '--reasoning-effort' && args[7] !== '') {
    return { sourceRoot: args[1]!, selectionFile: args[3]!, existingInboxId: args[5]!, reasoningEffort: args[7]! }
  }
  throw new Error('Usage: machtiani-installer-product-headless --source-root /absolute/path/to/machtiani --selection-file /private/selection.json [--existing-inbox-id TEST_INBOX_ID [--reasoning-effort EFFORT]]')
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[\r\n\0]/u.test(value)
}

function parseSelection(value: unknown): HeadlessSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Headless selection is not a valid object.')
  const selection = value as Record<string, unknown>
  if (!exactKeys(selection, selection.customProvider === undefined ? selectionKeys : [...selectionKeys, 'customProvider'])) throw new Error('Headless selection has unexpected or missing fields.')
  if (!nonempty(selection.provider) || !nonempty(selection.model) || !nonempty(selection.transport) || !nonempty(selection.authorizedSender)) {
    throw new Error('Headless selection contains an invalid product choice.')
  }
  if (!Array.isArray(selection.detectedBackends) || !selection.detectedBackends.every(nonempty)) {
    throw new Error('Headless selection contains an invalid backend inventory.')
  }
  if (selection.backend === null || typeof selection.backend !== 'object' || Array.isArray(selection.backend)) {
    throw new Error('Headless selection contains an invalid backend.')
  }
  const backend = selection.backend as Record<string, unknown>
  if (!exactKeys(backend, backendKeys) || !nonempty(backend.name) || !nonempty(backend.id) || !nonempty(backend.executable) ||
    backend.status !== 'ready' || !nonempty(backend.summary)) {
    throw new Error('Headless selection requires one explicitly checked, ready backend.')
  }
  let customProvider: CustomOpenAIProviderConfig | undefined
  if (selection.customProvider !== undefined) {
    const value = selection.customProvider
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid custom provider settings.')
    const custom = value as Record<string, unknown>
    if (!exactKeys(custom, ['kind', 'scope', 'name', 'chatCompletionsEndpoint', 'usesApiKey']) ||
      custom.kind !== 'openai-compatible' || (custom.scope !== 'remote' && custom.scope !== 'local') ||
      selection.provider !== `custom-openai-${custom.scope}` || !nonempty(custom.name) ||
      typeof custom.chatCompletionsEndpoint !== 'string' || typeof custom.usesApiKey !== 'boolean') {
      throw new Error('Invalid custom provider settings.')
    }
    customProvider = {
      kind: custom.kind, scope: custom.scope, name: custom.name,
      chatCompletionsEndpoint: validateCustomOpenAIEndpoint(custom.chatCompletionsEndpoint, custom.scope),
      usesApiKey: custom.usesApiKey,
    }
  } else if (selection.provider === 'custom-openai-remote' || selection.provider === 'custom-openai-local') {
    throw new Error('Custom provider settings are required.')
  }
  return {
    ...(customProvider === undefined ? {} : { customProvider }),
    provider: selection.provider,
    model: selection.model,
    transport: selection.transport,
    authorizedSender: selection.authorizedSender,
    detectedBackends: [...selection.detectedBackends],
    backend: {
      name: backend.name,
      id: backend.id,
      executable: backend.executable,
      status: backend.status,
      summary: backend.summary,
    },
  }
}

export async function loadHeadlessSelection(path: string): Promise<HeadlessSelection> {
  if (!isAbsolute(path)) throw new Error('--selection-file must be an absolute path.')
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > 16_384 || !await hasPrivatePermissions(path) || !owned) {
    throw new Error('Headless selection must be a small private regular file owned by the current user.')
  }
  return parseSelection(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

export async function saveHeadlessModelProfile(
  home: string,
  stateDirectory: string,
  selection: Pick<HeadlessSelection, 'provider' | 'model' | 'customProvider'>,
  reasoningEffort?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const credentialPath = join(home, '.config', 'dearmachine', 'backends.env')
  const modelProfilePath = join(home, '.config', 'machtiani', 'model-profile.json')
  const setup = await InstallerModelSetup.open(join(stateDirectory, 'dsh'), environment, { credentialPath, home })
  try {
    await saveModelHostProfile(modelProfilePath, setup.profileFor({
      provider: selection.provider,
      model: selection.model,
      ...(selection.customProvider === undefined ? {} : { customProvider: selection.customProvider }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }))
  } finally {
    await setup.close()
  }
  return modelProfilePath
}

export async function runHeadlessProductInstallation(sourceRoot: string, selectionFile: string, existingInboxId?: string, reasoningEffort?: string): Promise<InstalledProducts> {
  const source = await validatedSourceRoot(sourceRoot)
  const method = process.env.MACHTIANI_INSTALL_METHOD
  if (method !== undefined && method !== 'standard' && method !== 'nix' && method !== 'container') throw new Error('invalid installation method')
  const distribution = method === 'nix' ? undefined : await loadDistribution(process.env)
  if ((method === 'standard' || method === 'container') && distribution === undefined) throw new Error('this installation method requires a complete supplied distribution')
  const home = process.env.HOME
  if (home === undefined || home === '') throw new Error('HOME is required for headless product installation.')
  const paths = defaultInstallerPaths()
  const selection = await loadHeadlessSelection(selectionFile)
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  try {
    await saveSourceReference(home, await resolveSourceReference(source))
    const modelProfilePath = await saveHeadlessModelProfile(home, paths.stateDirectory, selection, reasoningEffort)
    const installerOptions = {
      ...(distribution === undefined ? {} : { distribution }),
      home,
      sourceRoot: source,
      workspace: paths.workspace,
      journalPath: join(paths.stateDirectory, 'product-installation.json'),
      diagnosticPath: join(paths.stateDirectory, 'product-command-diagnostic.json'),
      modelProfilePath,
    }
    const configuredOptions = reasoningEffort === undefined ? installerOptions : { ...installerOptions, reasoningEffort }
    const installer = existingInboxId === undefined
      ? new NativeProductInstaller(configuredOptions)
      : new NativeProductInstaller({ ...configuredOptions, existingInboxId })
    return await installer.install(selection)
  } finally {
    await lock.release()
  }
}
