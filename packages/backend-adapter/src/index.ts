import { spawn } from 'node:child_process'
import { access, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { BackendCandidate, BackendPort, BackendReadiness } from '@dearmachine/machtiani-installer-workflow'

const catalog = [
  { name: 'Codex', id: 'codex-yolo', command: 'codex' },
  { name: 'Forge', id: 'forge', command: 'forge' },
  { name: 'OMP', id: 'omp', command: 'omp' },
] as const

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
    const extra = this.options.providerEnvironmentPath === undefined
      ? {}
      : await loadPrivateEnvironment(this.options.providerEnvironmentPath)
    const results: BackendReadiness[] = []
    for (const candidate of candidates) results.push(await this.checkOne(candidate, extra))
    return results
  }

  private async checkOne(candidate: BackendCandidate, providerEnvironment: NodeJS.ProcessEnv): Promise<BackendReadiness> {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-health-'))
    try {
      await runBounded(['git', 'init', '--quiet'], root, { ...process.env, ...this.options.environment }, 30_000)
      const command = this.options.managerCommand ?? ['agent-manager']
      const result = await runBounded(
        [...command, 'backend', 'health', candidate.id],
        root,
        {
          ...process.env,
          ...this.options.environment,
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

interface ProcessResult { code: number | null; stdout: string; stderr: string }

async function runBounded(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
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
