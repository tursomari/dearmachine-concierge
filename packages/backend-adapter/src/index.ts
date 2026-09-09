import { spawn } from 'node:child_process'
import { access, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { BackendCandidate, BackendPort, BackendReadiness } from '@dearmachine/machtiani-installer-workflow'

const catalog = [
  { name: 'Codex', id: 'codex-yolo', command: 'codex' },
  { name: 'Forge', id: 'forge', command: 'forge' },
  { name: 'OMP', id: 'omp', command: 'omp' },
] as const

const privateEnvironmentName = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|ACCESS_KEY(?:_ID)?)$/u

function backendBaseEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides }
  for (const name of Object.keys(environment)) {
    if (privateEnvironmentName.test(name)) delete environment[name]
  }
  return environment
}

async function executableOnPath(command: string, pathValue: string): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch { /* keep searching */ }
  }
  return undefined
}

export async function loadPrivateEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !owned) {
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
    const environment = { ...process.env, ...this.options.environment }
    const pathValue = environment.PATH ?? ''
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
  forgeCommand?: string
  timeoutMs?: number
  run?: (command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProcessResult>
}

async function assertPrivateForgeCredentialStore(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !owned) throw new Error()
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
  const providerEnvironment = await loadPrivateEnvironment(options.providerEnvironmentPath)
  const command = options.forgeCommand ?? 'forge'
  const execute = options.run ?? runBounded
  const environment = { ...backendBaseEnvironment(undefined), HOME: options.home, FORGE_TERM: 'false' }
  const versionResult = await execute([command, '--version'], options.home, environment, 30_000)
  const version = /(?:^|\s)(2\.13\.21)(?:\s|$)/u.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1]
  if (versionResult.code !== 0 || version !== '2.13.21') {
    throw new Error('The installed Forge version is not the verified 2.13.21 compatibility target; inspect its current authentication flow instead.')
  }
  if (!['openrouter', 'deepseek', 'openai'].includes(options.provider)) {
    throw new Error(`Forge 2.13.21 migration does not support provider ${options.provider}.`)
  }
  const compatibilityPath = join(options.home, '.env')
  try {
    await lstat(compatibilityPath)
    throw new Error('Forge credential migration refused to replace the existing ~/.env path.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const providerName = options.provider === 'openrouter' ? 'open_router' : options.provider
  const probe = await mkdtemp(join(tmpdir(), 'machtiani-forge-prepare-'))
  let linked = false
  try {
    await symlink(await realpath(options.providerEnvironmentPath), compatibilityPath)
    linked = true
    // Forge 2.13.21 imports a provider key from its environment only while
    // entering direct mode. A closed stdin may make that command exit non-zero
    // after the import, so the private store is the authoritative postcondition.
    await execute([command], options.home, { ...environment, ...providerEnvironment }, 60_000)
    await assertPrivateForgeCredentialStore(join(options.home, '.forge', '.credentials.json'))
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
    version: '2.13.21', provider: options.provider, model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    credentialMigration: 'performed', probe: 'passed', compatibilitySurfaceCleanup: 'removed',
  }
}

export async function runBounded(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), { cwd, env: environment, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
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
