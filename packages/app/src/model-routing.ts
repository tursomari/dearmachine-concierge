import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import type { ModelComponent } from '@dearmachine/machtiani-model-host'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'smol-toml'

export class ModelRoutingError extends Error {}
const configHelp = 'Inspect ~/.config/dearmachine/machtiani/config.toml, correct the configuration, then retry /model. Signing in again will not fix this.'
type Table = Record<string, unknown>
function table(value: unknown): Table {
  if (value === undefined) return Object.create(null) as Table
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ModelRoutingError('The model configuration contains an invalid table. ' + configHelp)
  return value as Table
}
function parsed(content: string): Table {
  try { return parse(content, { integersAsBigInt: true }) }
  catch { throw new ModelRoutingError('The harness model configuration could not be parsed. ' + configHelp) }
}

export async function writePrivateModelFile(path: string, content: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await protectPrivatePath(temporary, 0o600)
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

/** Explicit /model changes route only the selected components. Existing named
 * models, credentials, comments and unrelated settings remain byte-for-byte.
 * Parse both documents and compare the full result before accepting text edits.
 */
export async function prepareModelRouting(home: string, profile: string, components: ModelComponent[]): Promise<undefined | { commit(): Promise<void> }> {
  if (components.length === 0) return
  const path = join(home, '.config/dearmachine/machtiani/config.toml')
  let original: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || !await hasPrivatePermissions(path)) {
      throw new ModelRoutingError('The harness model configuration must be a private file owned by your account. ' + configHelp)
    }
    original = await readFile(path, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const expected = parsed(original)
  const providers = table(expected.providers)
  const models = table(expected.models)
  expected.providers = providers
  expected.models = models
  let next = original
  const append = (text: string) => { next = next + '\n\n' + text + '\n' }
  const provider = providers['dearmachine-host']
  if (provider === undefined) {
    providers['dearmachine-host'] = Object.assign(Object.create(null), { transport: 'model-host', profile, command: 'machtiani-model-host' })
    append('[providers.dearmachine-host]\ntransport = "model-host"\nprofile = ' + JSON.stringify(profile) + '\ncommand = "machtiani-model-host"')
  } else {
    const existing = table(provider)
    const existingProfile = typeof existing.profile === 'string' && existing.profile.startsWith('~/')
      ? join(home, existing.profile.slice(2)) : existing.profile
    if (existing.transport !== 'model-host' || typeof existingProfile !== 'string' || resolve(existingProfile) !== resolve(profile)) {
      throw new ModelRoutingError('The dearmachine-host provider is assigned to a different configuration. Keep that provider under another name before changing harness models. ' + configHelp)
    }
  }
  const route = (key: string, alias: string) => {
    if (expected[key] === alias) return
    expected[key] = alias
    const pattern = new RegExp('^([\\t ]*(?:' + key + '|"' + key + '"|\'' + key + '\')[\\t ]*=[\\t ]*)(?:"(?:\\\\.|[^"\\\\])*"|\'[^\']*\')([\\t ]*(?:#.*)?)$', 'mu')
    if (pattern.test(next)) next = next.replace(pattern, (_match, prefix: string, suffix: string) => prefix + JSON.stringify(alias) + suffix)
    else next = key + ' = ' + JSON.stringify(alias) + '\n' + next
  }
  for (const component of components) {
    if (component === 'concierge') continue
    const desired = Object.assign(Object.create(null), { provider: 'dearmachine-host', model: '@machtiani/' + component, context_length: 131072n })
    const base = 'dearmachine-' + component
    let alias = base
    // Sync has a public native alias; never overwrite a custom model using it.
    if (component === 'sync' && Object.hasOwn(models, alias) && !isDeepStrictEqual(models[alias], desired)) {
      throw new ModelRoutingError('The dearmachine-sync model has custom settings. Keep it under another name before changing the sync selection. ' + configHelp)
    }
    for (let suffix = 2; Object.hasOwn(models, alias) && !isDeepStrictEqual(models[alias], desired); suffix++) alias = base + '-' + suffix
    if (!Object.hasOwn(models, alias)) {
      models[alias] = desired
      append('[models.' + alias + ']\nprovider = "dearmachine-host"\nmodel = "@machtiani/' + component + '"\ncontext_length = 131072')
    }
    if (component === 'planner') for (const key of ['default_model', 'answer_model', 'file_discovery_model']) route(key, alias)
    if (component === 'shell-agent') route('shell_agent_model', alias)
  }
  if (next === original) return
  if (!isDeepStrictEqual(parsed(next), expected)) throw new ModelRoutingError('The harness configuration could not be updated without changing unrelated settings. ' + configHelp)
  return { commit: async () => {
    if (await readFile(path, 'utf8') !== original) throw new ModelRoutingError('The harness configuration changed while you were choosing a model. Retry /model.')
    // Keep the complete original, including custom model parameters and comments.
    const backup = path + '.before-model-selection-' + randomUUID()
    await writeFile(backup, original, { mode: 0o600, flag: 'wx' })
    await protectPrivatePath(backup, 0o600)
    await writePrivateModelFile(path, next)
  } }
}
