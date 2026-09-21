import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { BackendCandidate, BackendPort, BackendReadiness } from '@dearmachine/machtiani-installer-workflow'

const catalog = [
  { name: 'Codex', id: 'codex-yolo', command: 'codex' },
  { name: 'Forge', id: 'forge', command: 'forge' },
  { name: 'OMP', id: 'omp', command: 'omp' },
  { name: 'Claude Code', id: 'claude', command: 'claude' },
] as const

const privateEnvironmentName = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|ACCESS_KEY(?:_ID)?)$/iu

function backendBaseEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides }
  for (const name of Object.keys(environment)) {
    if (privateEnvironmentName.test(name)) delete environment[name]
  }
  if (process.platform === 'win32') {
    const path = overriddenPath(overrides) ?? process.env.PATH ?? ''
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key]
    environment.PATH = path
  }
  return environment
}

// Windows environment names are case-insensitive, including explicit overrides.
// A spread of process.env becomes a plain object and loses that behavior.
function overriddenPath(environment: NodeJS.ProcessEnv | undefined): string | undefined {
  if (environment === undefined) return undefined
  if (process.platform !== 'win32') return environment.PATH
  const key = Object.keys(environment).find(name => name.toUpperCase() === 'PATH')
  return key === undefined ? undefined : environment[key]
}

async function executableOnPath(command: string, pathValue: string): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const names = process.platform === 'win32' ? [command + '.exe', command + '.com', command + '.cmd', command] : [command]
    for (const name of names) {
      const candidate = join(directory, name)
      try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch { /* keep searching */ }
    }
  }
  return undefined
}

export async function loadPrivateEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || !await hasPrivatePermissions(path) || !owned) {
    throw new Error('provider credential file must be a private regular file owned by the current user')
  }
  const content = await readFile(path, 'utf8')
  const result: NodeJS.ProcessEnv = {}
  for (const line of content.split(/\r?\n/gu)) {
    if (line === '') continue
    const match = /^([A-Z_][A-Z0-9_]*)=(\S+)$/u.exec(line)
    if (match === null) throw new Error('provider credential file contains an invalid assignment')
    result[match[1]!] = match[2]!
  }
  if (Object.keys(result).length === 0) throw new Error('provider credential file contains no assignments')
  return result
}

export interface BackendAdapterOptions {
  environment?: NodeJS.ProcessEnv
  providerEnvironmentPath?: string
  providerEnvironmentBackendIds?: readonly string[]
  managerCommand?: readonly string[]
  timeoutMs?: number
}

export class AgentManagerBackendAdapter implements BackendPort {
  constructor(private readonly options: BackendAdapterOptions = {}) {}

  async discover(): Promise<readonly BackendCandidate[]> {
    const pathValue = overriddenPath(this.options.environment) ?? process.env.PATH ?? ''
    const candidates: BackendCandidate[] = []
    for (const entry of catalog) {
      const executable = await executableOnPath(entry.command, pathValue)
      if (executable !== undefined) candidates.push({ name: entry.name, id: entry.id, executable })
    }
    return candidates
  }

  async check(candidates: readonly BackendCandidate[]): Promise<readonly BackendReadiness[]> {
    const permitted = new Set(this.options.providerEnvironmentBackendIds ?? [])
    const extra = this.options.providerEnvironmentPath === undefined || permitted.size === 0
      ? {}
      : await loadPrivateEnvironment(this.options.providerEnvironmentPath)
    const results: BackendReadiness[] = []
    for (const candidate of candidates) {
      results.push(await this.checkOne(candidate, permitted.has(candidate.id) ? extra : {}))
    }
    return results
  }

  private async checkOne(candidate: BackendCandidate, providerEnvironment: NodeJS.ProcessEnv): Promise<BackendReadiness> {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-health-'))
    const environment = backendBaseEnvironment(this.options.environment)
    try {
      await runBounded(['git', 'init', '--quiet'], root, environment, 30_000)
      const command = this.options.managerCommand ?? ['agent-manager']
      const result = await runBounded(
        [...command, 'backend', 'health', candidate.id],
        root,
        {
          ...environment,
          ...providerEnvironment,
          DEARMACHINE_BACKENDS: JSON.stringify([candidate.id]),
        },
        this.options.timeoutMs ?? 180_000,
      )
      if (result.code === 0 && /(?:^|\n)result=ok(?:\n|$)/u.test(result.stdout)) {
        return { ...candidate, status: 'ready', summary: 'functional probe passed' }
      }
      const diagnostic = `${result.stderr}\n${result.stdout}`
      const status = /auth|credential|api.?key|sign.?in|login|unauthorized/iu.test(diagnostic)
        ? 'authentication-required'
        : 'unhealthy'
      return { ...candidate, status, summary: status === 'authentication-required' ? 'sign-in is required' : 'functional probe failed' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /auth|credential|api.?key|sign.?in|login|unauthorized/iu.test(message)
        ? 'authentication-required'
        : 'unhealthy'
      return { ...candidate, status, summary: status === 'authentication-required' ? 'sign-in is required' : 'functional probe could not run' }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string }

export interface ForgePreparationReceipt {
  version: '2.13.21'
  provider: string
  model: string
  reasoningEffort?: string
  credentialMigration: 'performed'
  probe: 'passed'
  compatibilitySurfaceCleanup: 'removed'
}

export interface ForgePreparationOptions {
  home: string
  providerEnvironmentPath: string
  provider: string
  model: string
  reasoningEffort?: string
  customProvider?: { endpoint: string; credentialVariable: string }
  forgeCommand?: string
  timeoutMs?: number
  run?: (command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProcessResult>
}

function validateCustomProvider(options: ForgePreparationOptions): void {
  const custom = options.customProvider
  if (custom === undefined) return
  let endpoint: URL
  try { endpoint = new URL(custom.endpoint) } catch { throw new Error('Custom provider endpoint must be an absolute HTTP(S) URL.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[\s\u0000-\u001f]/u.test(custom.endpoint)) {
    throw new Error('Custom provider endpoint requires HTTPS (HTTP only for loopback), without credentials, query parameters or fragments.')
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(options.provider)) throw new Error('Custom provider ID must use lowercase letters, numbers and underscores.')
  if (!/^[A-Z][A-Z0-9_]{0,120}_API_KEY$/u.test(custom.credentialVariable)) throw new Error('Custom provider credential variable must be an API-key reference.')
  if (options.model.trim() === '' || /[\u0000-\u001f\u007f]/u.test(options.model)) throw new Error('Custom provider model must be a nonempty model ID.')
  if (options.reasoningEffort !== undefined) {
    throw new Error('Forge 2.13.21 does not forward reasoning effort for custom provider IDs. Ask the human whether to use provider-default reasoning or another backend; omit --reasoning-effort only after they approve provider defaults.')
  }
}

/** Forge 2.13.21's provider.json supports independent, non-secret definitions. */
async function registerCustomForgeProvider(options: ForgePreparationOptions): Promise<void> {
  const custom = options.customProvider!
  const directory = join(options.home, '.forge')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
    throw new Error('Forge configuration directory must be a real directory owned by the current user.')
  }
  const path = join(directory, 'provider.json')
  let providers: Record<string, unknown>[] = []
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink() || (process.getuid !== undefined && file.uid !== process.getuid())) throw new Error('unsafe file')
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(parsed) || parsed.some(p => typeof p !== 'object' || p === null || Array.isArray(p) || typeof p.id !== 'string')) throw new Error('invalid providers')
    providers = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Existing Forge provider configuration is unsafe or invalid; it was not replaced.')
  }
  const candidate = {
    id: `machtiani_${options.provider}`, api_key_vars: custom.credentialVariable, url_param_vars: [],
    response_type: 'OpenAI', auth_methods: ['api_key'], url: custom.endpoint,
    models: [{ id: options.model, name: options.model, tools_supported: true, supports_parallel_tool_calls: true, input_modalities: ['text'] }],
  }
  const existing = providers.find(provider => provider.id === candidate.id)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error('A different Forge custom provider already uses this ID; preserve it and choose a distinct ID.')
    return
  }
  const temporary = join(directory, `.provider-${randomUUID()}.json`)
  try {
    await writeFile(temporary, `${JSON.stringify([...providers, candidate], undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

async function assertPrivateForgeCredentialStore(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || !await hasPrivatePermissions(path) || !owned) throw new Error()
  } catch {
    throw new Error('Forge did not import the selected provider credential into its private credential store.')
  }
}

function forgeConfigMatches(result: ProcessResult, label: 'Provider' | 'Model', expected: string): boolean {
  if (result.code !== 0) return false
  return result.stdout.split(/\r?\n/gu).some(line => {
    const output = line.trim()
    const value = output.startsWith(`${label}: `) ? output.slice(label.length + 2) : output
    if (label === 'Provider') {
      const canonical = (provider: string): string => provider.toLowerCase().replace(/[^a-z0-9]/gu, '')
      return canonical(value) === canonical(expected)
    }
    return value === expected
  })
}

/**
 * Performs the one verified Forge 2.13.21 API-key migration without leaving a
 * broad home-directory credential surface behind. Call only after Forge was
 * explicitly selected by the human.
 */
export async function prepareForge21321(options: ForgePreparationOptions): Promise<ForgePreparationReceipt> {
  validateCustomProvider(options)
  const providerEnvironment = await loadPrivateEnvironment(options.providerEnvironmentPath)
  const selectedEnvironment = options.customProvider === undefined ? providerEnvironment : {
    [options.customProvider.credentialVariable]: providerEnvironment[options.customProvider.credentialVariable],
  }
  if (options.customProvider !== undefined && !selectedEnvironment[options.customProvider.credentialVariable]) {
    throw new Error('The custom provider credential reference is missing; use the secure credential helper first.')
  }
  const command = options.forgeCommand ?? 'forge'
  const execute = options.run ?? runBounded
  const environment = { ...backendBaseEnvironment(undefined), HOME: options.home, FORGE_TERM: 'false',
    ...(options.customProvider === undefined && process.platform !== 'win32' ? {} : { FORGE_CONFIG: join(options.home, '.forge') }) }
  const versionResult = await execute([command, '--version'], options.home, environment, 30_000)
  const version = /(?:^|\s)(2\.13\.21)(?:\s|$)/u.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1]
  if (versionResult.code !== 0 || version !== '2.13.21') {
    throw new Error('The installed Forge version is not the verified 2.13.21 compatibility target; inspect its current authentication flow instead.')
  }
  if (options.customProvider === undefined && !['openrouter', 'deepseek', 'openai'].includes(options.provider)) {
    throw new Error(`Forge 2.13.21 migration does not support provider ${options.provider}.`)
  }
  const compatibilityPath = join(options.home, '.env')
  try {
    await lstat(compatibilityPath)
    throw new Error('Forge credential migration refused to replace the existing ~/.env path.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const providerName = options.customProvider !== undefined ? `machtiani_${options.provider}`
    : options.provider === 'openrouter' ? 'open_router' : options.provider
  const probe = await mkdtemp(join(tmpdir(), 'machtiani-forge-prepare-'))
  let linked = false
  try {
    await protectPrivatePath(probe, 0o700)
    if (process.platform === 'win32') {
      const directory = join(options.home, '.forge')
      await mkdir(directory, { recursive: true })
      await protectPrivatePath(directory, 0o700)
    }
    let migrationPath = await realpath(options.providerEnvironmentPath)
    if (options.customProvider !== undefined) {
      await registerCustomForgeProvider(options)
      migrationPath = join(probe, 'credential.env')
      await writeFile(migrationPath, `${options.customProvider.credentialVariable}=${selectedEnvironment[options.customProvider.credentialVariable]}\n`, { mode: 0o600, flag: 'wx' })
    }
    if (process.platform === 'win32') {
      // Ordinary Windows users cannot normally create file symlinks. Create an
      // empty exclusive file, restrict its ACL, then copy through this trusted
      // helper so no credential bytes ever enter an agent tool response.
      await writeFile(compatibilityPath, '', { flag: 'wx', mode: 0o600 })
      linked = true
      await protectPrivatePath(compatibilityPath, 0o600)
      await writeFile(compatibilityPath, await readFile(migrationPath))
    } else {
      await symlink(migrationPath, compatibilityPath)
      linked = true
    }
    // Forge 2.13.21 imports a provider key from its environment only while
    // entering direct mode. A closed stdin may make that command exit non-zero
    // after the import, so the private store is the authoritative postcondition.
    await execute([command], options.home, { ...environment, ...selectedEnvironment }, 60_000)
    await assertPrivateForgeCredentialStore(join(options.home, '.forge', '.credentials.json'))
    if (options.customProvider !== undefined) {
      let imported = false
      try {
        const credentials: unknown = JSON.parse(await readFile(join(options.home, '.forge', '.credentials.json'), 'utf8'))
        imported = Array.isArray(credentials) && credentials.some(value => value?.id === providerName)
      } catch { /* Never include private-store contents or parser excerpts in errors. */ }
      if (!imported) throw new Error('Forge did not import the selected custom provider credential.')
    }
    await unlink(compatibilityPath)
    linked = false

    const configured = await execute([command, 'config', 'set', 'model', providerName, options.model], options.home, environment, 60_000)
    if (configured.code !== 0) throw new Error('Forge did not accept the selected provider and model.')
    const [selectedProvider, selectedModel] = await Promise.all([
      execute([command, 'config', 'get', 'provider', '--porcelain'], options.home, environment, 30_000),
      execute([command, 'config', 'get', 'model', '--porcelain'], options.home, environment, 30_000),
    ])
    if (!forgeConfigMatches(selectedProvider, 'Provider', providerName) || !forgeConfigMatches(selectedModel, 'Model', options.model)) {
      throw new Error('Forge did not retain the selected provider and model after credential import.')
    }
    if (options.reasoningEffort !== undefined) {
      const configuredReasoning = await execute(
        [command, 'config', 'set', 'reasoning-effort', options.reasoningEffort], options.home, environment, 30_000,
      )
      if (configuredReasoning.code !== 0) throw new Error('Forge did not accept the selected reasoning effort.')
      const retainedReasoning = await execute(
        [command, 'config', 'get', 'reasoning-effort', '--porcelain'], options.home, environment, 30_000,
      )
      if (retainedReasoning.code !== 0 || retainedReasoning.stdout.trim() !== options.reasoningEffort) {
        throw new Error('Forge did not retain the selected reasoning effort.')
      }
    }
    await execute(['git', 'init', '--quiet'], probe, environment, 30_000)
    const checked = await execute(
      [command, '-C', probe, '--prompt', 'Reply with exactly READY. Do not run tools or alter files.'],
      probe,
      environment,
      options.timeoutMs ?? 180_000,
    )
    if (checked.code !== 0 || !/(?:^|\s)READY(?:\s|$)/u.test(checked.stdout)) {
      throw new Error('Forge credential migration completed, but its functional model probe failed.')
    }
  } finally {
    if (linked) await unlink(compatibilityPath)
    await rm(probe, { recursive: true, force: true })
  }
  return {
    version: '2.13.21', provider: options.customProvider === undefined ? options.provider : providerName, model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    credentialMigration: 'performed', probe: 'passed', compatibilitySurfaceCleanup: 'removed',
  }
}

export async function runBounded(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), { cwd, env: environment, signal: controller.signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const append = (current: string, chunk: unknown): string => `${current}${String(chunk)}`.slice(-65_536)
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
  } finally {
    clearTimeout(timer)
  }
}
