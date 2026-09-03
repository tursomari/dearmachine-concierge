import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { loadPrivateEnvironment } from '@dearmachine/machtiani-installer-backends'
import type { ReadyInstallationSelection } from '@dearmachine/machtiani-installer-workflow'

export interface CommandRequest {
  label: string
  command: readonly string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

export class CommandExecutionError extends Error {
  readonly #diagnostic: Readonly<CommandResult>

  constructor(readonly label: string, readonly code: number | null, diagnostic: CommandResult) {
    super(`${label} failed with status ${code ?? 'unknown'}. The installer retained the private diagnostic for troubleshooting.`)
    this.name = 'CommandExecutionError'
    this.#diagnostic = { ...diagnostic }
  }

  privateDiagnostic(): Readonly<CommandResult> {
    return { ...this.#diagnostic }
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 900_000)
    try {
      const result = await new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(request.command[0]!, request.command.slice(1), {
          cwd: request.cwd,
          env: request.environment,
          signal: controller.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        const append = (current: string, chunk: unknown): string => `${current}${String(chunk)}`.slice(-1_048_576)
        child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
        child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
        child.once('error', reject)
        child.once('close', code => resolve({ code, stdout, stderr }))
        child.stdin.on('error', () => { /* an early child exit can close stdin before end() */ })
        child.stdin.end(request.stdin)
      })
      if (result.code !== 0) throw new CommandExecutionError(request.label, result.code, result)
      return result
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error
      if (controller.signal.aborted) throw new Error(`${request.label} timed out before it completed.`)
      throw new Error(`${request.label} could not start.`)
    } finally {
      clearTimeout(timer)
    }
  }
}

interface ProviderSpec { preset: string; variable: string }
interface TransportSpec { id: string; variable: string; credentialPath: string }

const providers: Readonly<Record<string, ProviderSpec>> = {
  openrouter: { preset: 'openrouter', variable: 'OPENROUTER_API_KEY' },
  deepseek: { preset: 'deepseek', variable: 'DEEPSEEK_API_KEY' },
  'deepseek official': { preset: 'deepseek', variable: 'DEEPSEEK_API_KEY' },
}

const transports: Readonly<Record<string, Omit<TransportSpec, 'credentialPath'>>> = {
  agentmail: { id: 'agentmail', variable: 'AGENTMAIL_API_KEY_FILE' },
  openmail: { id: 'openmail', variable: 'OPENMAIL_API_KEY_FILE' },
  sendmux: { id: 'sendmux', variable: 'SENDMUX_API_KEY_FILE' },
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ')
}

function providerSpec(selection: string): ProviderSpec {
  const spec = providers[normalized(selection)]
  if (spec === undefined) throw new Error(`Product installation does not yet support provider ${selection}.`)
  return spec
}

function transportSpec(selection: string, home: string): TransportSpec {
  const spec = transports[normalized(selection)]
  if (spec === undefined) throw new Error(`Product installation does not yet support email transport ${selection}.`)
  return { ...spec, credentialPath: join(home, '.config', 'dearmachine', `${spec.id}-api-key`) }
}

async function privateRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path)
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || (metadata.mode & 0o077) !== 0 || !owned) {
    throw new Error('transport credential must be a nonempty private regular file owned by the current user')
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try { return (await readdir(path)).length > 0 } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

function commandPath(environment: NodeJS.ProcessEnv, home: string): string {
  return [join(home, '.local', 'bin'), join(home, '.nix-profile', 'bin'), environment.PATH ?? ''].filter(Boolean).join(delimiter)
}

function parseInbox(status: string, sender: string, transport: string): string {
  const expectedSender = sender.trim().toLocaleLowerCase('en-US')
  for (const line of status.split(/\r?\n/gu)) {
    const fields = line.split('\t')
    if (fields.length === 4 && fields[1]?.toLocaleLowerCase('en-US') === expectedSender && fields[3] === transport) {
      const address = fields[2]?.trim()
      if (address !== undefined && address !== '') return address
    }
  }
  throw new Error('Dear Machine started, but its registered inbox could not be verified.')
}

export interface ProductInstallerOptions {
  home: string
  sourceRoot: string
  workspace: string
  environment?: NodeJS.ProcessEnv
  runner?: CommandRunner
}

export interface InstalledProducts { inboxAddress: string }

export class NativeProductInstaller {
  private readonly runner: CommandRunner

  constructor(private readonly options: ProductInstallerOptions) {
    this.runner = options.runner ?? new SpawnCommandRunner()
  }

  async install(selection: ReadyInstallationSelection): Promise<InstalledProducts> {
    if (selection.backend.status !== 'ready') throw new Error(`${selection.backend.name} must pass its readiness check before product installation.`)
    if (await directoryHasEntries(join(this.options.home, '.dearmachine'))) {
      throw new Error('An existing Dear Machine installation was found. The installer will not change its pairs, inboxes, or running client automatically.')
    }
    if (await directoryHasEntries(join(this.options.home, '.machtiani'))) {
      throw new Error('An existing Machtiani configuration was found. The installer will not replace it automatically.')
    }

    const provider = providerSpec(selection.provider)
    const transport = transportSpec(selection.transport, this.options.home)
    const providerEnvironment = await loadPrivateEnvironment(join(this.options.home, '.config', 'dearmachine', 'backends.env'))
    const providerCredential = providerEnvironment[provider.variable]
    if (providerCredential === undefined || providerCredential.trim() === '') {
      throw new Error(`The private provider environment is missing ${provider.variable}.`)
    }
    await privateRegularFile(transport.credentialPath)

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.environment,
      ...providerEnvironment,
      HOME: this.options.home,
      PATH: commandPath({ ...process.env, ...this.options.environment }, this.options.home),
      [transport.variable]: transport.credentialPath,
      DEARMACHINE_BACKENDS: JSON.stringify([selection.backend.id]),
    }
    const harness = join(this.options.sourceRoot, 'machtiani-harness')
    const dearMachine = join(this.options.sourceRoot, 'dearmachine')
    const deviceConfig = join(this.options.home, '.dearmachine', 'config', 'dearmachine.toml')
    const entryPoint = join(this.options.home, '.dearmachine', 'entrypoint', 'main')
    const run = async (label: string, command: readonly string[], cwd = this.options.workspace, stdin?: string): Promise<CommandResult> => {
      const request: CommandRequest = { label, command, cwd, environment }
      if (stdin !== undefined) request.stdin = stdin
      return await this.runner.run(request)
    }

    await mkdir(this.options.workspace, { recursive: true, mode: 0o700 })
    const sourceBefore = (await run('Source checkout preflight', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
    const providerCheckRoot = await mkdtemp(join(this.options.workspace, 'provider-check-'))
    await writeFile(join(providerCheckRoot, 'README.md'), '# Machtiani Installer provider check\n', { flag: 'wx' })
    await run('Initialize provider-check workspace', ['git', 'init', '--quiet'], providerCheckRoot)
    await run('Configure provider-check identity', ['git', 'config', 'user.name', 'Machtiani Installer'], providerCheckRoot)
    await run('Configure provider-check email', ['git', 'config', 'user.email', 'installer@localhost.invalid'], providerCheckRoot)
    await run('Stage provider-check workspace', ['git', 'add', 'README.md'], providerCheckRoot)
    await run('Commit provider-check workspace', ['git', 'commit', '--quiet', '-m', 'chore: initialize provider check'], providerCheckRoot)

    await run('Install Machtiani', ['nix', 'run', `path:${harness}#install`, '--', '--no-interactive'], harness)
    await run('Configure Machtiani', [
      'machtiani', 'init', '--no-interactive', '--config-scope', 'global',
      '--preset', provider.preset, '--model', selection.model, '--alias', 'dearmachine', '--api-key-env', provider.variable,
    ], providerCheckRoot)
    const machtianiConfig = await readFile(join(this.options.home, '.machtiani', 'config.toml'), 'utf8')
    const credentialReference = `api_key = "\${${provider.variable}}"`
    if (!machtianiConfig.split(/\r?\n/gu).some(line => line.trim() === credentialReference)) {
      throw new Error('Machtiani configuration did not retain a safe provider credential reference.')
    }
    await run('Synchronize Machtiani provider check', ['machtiani', 'sync'])
    const providerCheck = await run(
      'Check Machtiani provider',
      ['machtiani', 'run', '--mode', 'code', '-p', 'Reply with exactly MACHTIANI_PROVIDER_OK without changing files.'],
      providerCheckRoot,
      'c\n',
    )
    if (!providerCheck.stdout.includes('MACHTIANI_PROVIDER_OK')) throw new Error('Machtiani completed its live provider check without the expected confirmation.')

    await run('Install Dear Machine', ['nix', 'profile', 'install', `path:${dearMachine}#dearmachine`], dearMachine)
    await run('Verify installed commands', ['sh', '-c', 'command -v machtiani dearmachine agent-manager >/dev/null'])
    await run('Configure selected backend', ['dearmachine', 'setup-agents', '--backend', selection.backend.id], this.options.workspace, '\n')
    await writePrivate(deviceConfig, `version = 1\nbackends = [${JSON.stringify(selection.backend.id)}]\nresponse_tier = "formatted"\n`)
    await run('Create Dear Machine pair', [
      'dearmachine', 'up', '--create', '--email', selection.authorizedSender,
      '--new-inbox', '--transport', transport.id,
      '--project', entryPoint, '--entry-point-repo', entryPoint,
      '--config', deviceConfig, '--poll-interval', '5s', '--magnifica-humanitas', '--verbose',
    ])
    const status = await run('Verify Dear Machine status', ['dearmachine', 'status'])
    if (!status.stdout.includes('DearMachine is running')) throw new Error('Dear Machine did not report a running native client.')
    const inboxAddress = parseInbox(status.stdout, selection.authorizedSender, transport.id)
    const backendCheck = await run('Verify selected backend', ['agent-manager', 'backend', 'health', selection.backend.id], entryPoint)
    if (!/(?:^|\n)result=ok(?:\n|$)/u.test(backendCheck.stdout)) throw new Error('The installed selected backend did not pass its functional health check.')

    const sourceAfter = (await run('Verify source checkout', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
    if (sourceAfter !== sourceBefore) throw new Error('Product installation changed the source checkout; the installer stopped before verification could complete.')
    return { inboxAddress }
  }
}
