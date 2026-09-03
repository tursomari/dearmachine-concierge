import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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

async function verifiedMachtianiConfig(path: string, provider: ProviderSpec, model: string): Promise<boolean> {
  let content: string
  try { content = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const lines = new Set(content.split(/\r?\n/gu).map(line => line.trim()))
  const expected = [
    'default_model = "dearmachine"',
    `model = ${JSON.stringify(model)}`,
    `provider = ${JSON.stringify(provider.preset)}`,
    `api_key = "\${${provider.variable}}"`,
  ]
  if (!expected.every(line => lines.has(line))) {
    throw new Error('The installer-owned Machtiani configuration does not match the saved provider and model choices.')
  }
  return true
}

async function requireMachtianiConfig(path: string, provider: ProviderSpec, model: string): Promise<void> {
  if (!await verifiedMachtianiConfig(path, provider, model)) {
    throw new Error('Machtiani configuration was not created.')
  }
}

type ProductRun = (label: string, command: readonly string[], cwd?: string, stdin?: string) => Promise<CommandResult>

async function prepareProviderCheckWorkspace(workspace: string, run: ProductRun): Promise<string> {
  const root = await mkdtemp(join(workspace, 'provider-check-'))
  await writeFile(join(root, 'README.md'), '# Machtiani Installer provider check\n', { flag: 'wx' })
  await run('Initialize provider-check workspace', ['git', 'init', '--quiet'], root)
  await run('Configure provider-check identity', ['git', 'config', 'user.name', 'Machtiani Installer'], root)
  await run('Configure provider-check email', ['git', 'config', 'user.email', 'installer@localhost.invalid'], root)
  await run('Stage provider-check workspace', ['git', 'add', 'README.md'], root)
  await run('Commit provider-check workspace', ['git', 'commit', '--quiet', '-m', 'chore: initialize provider check'], root)
  return root
}

export interface ProductInstallerOptions {
  home: string
  sourceRoot: string
  workspace: string
  journalPath: string
  existingInboxId?: string
  environment?: NodeJS.ProcessEnv
  runner?: CommandRunner
}

export interface InstalledProducts { inboxAddress: string }

export type ProductStage =
  | 'started'
  | 'machtiani-installed'
  | 'machtiani-configured'
  | 'provider-verified'
  | 'dearmachine-installed'
  | 'backend-configured'
  | 'pair-creation-started'
  | 'pair-created'
  | 'verified'

interface JournalSelection {
  provider: string
  model: string
  transport: string
  authorizedSender: string
  backendId: string
  existingInboxIdHash?: string
}

interface ProductJournal {
  version: 1
  stage: ProductStage
  selection: JournalSelection
  sourceStatusHash: string
  inboxAddress?: string
}

const stages: readonly ProductStage[] = [
  'started', 'machtiani-installed', 'machtiani-configured', 'provider-verified',
  'dearmachine-installed', 'backend-configured', 'pair-creation-started', 'pair-created', 'verified',
]

function atLeast(current: ProductStage, expected: ProductStage): boolean {
  return stages.indexOf(current) >= stages.indexOf(expected)
}

function journalSelection(selection: ReadyInstallationSelection, existingInboxId: string | undefined): JournalSelection {
  const result: JournalSelection = {
    provider: selection.provider,
    model: selection.model,
    transport: selection.transport,
    authorizedSender: selection.authorizedSender,
    backendId: selection.backend.id,
  }
  if (existingInboxId !== undefined) result.existingInboxIdHash = statusHash(existingInboxId)
  return result
}

function statusHash(status: string): string {
  return createHash('sha256').update(status).digest('hex')
}

async function loadJournal(path: string): Promise<ProductJournal | undefined> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !owned) {
      throw new Error('product installation journal must be a private regular file owned by the current user')
    }
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ProductJournal>
    if (value.version !== 1 || !stages.includes(value.stage as ProductStage) || value.selection === undefined ||
      typeof value.sourceStatusHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceStatusHash)) {
      throw new Error('product installation journal is invalid')
    }
    return value as ProductJournal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function saveJournal(path: string, journal: ProductJournal): Promise<void> {
  await writePrivate(path, `${JSON.stringify(journal, undefined, 2)}\n`)
}

export class NativeProductInstaller {
  private readonly runner: CommandRunner

  constructor(private readonly options: ProductInstallerOptions) {
    this.runner = options.runner ?? new SpawnCommandRunner()
  }

  async install(selection: ReadyInstallationSelection): Promise<InstalledProducts> {
    if (selection.backend.status !== 'ready') throw new Error(`${selection.backend.name} must pass its readiness check before product installation.`)
    const existingInboxId = this.options.existingInboxId
    if (existingInboxId !== undefined && (existingInboxId.trim() === '' || /[\r\n\0]/u.test(existingInboxId))) {
      throw new Error('The pre-provisioned inbox ID is invalid.')
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
    const machtianiConfigPath = join(this.options.home, '.machtiani', 'config.toml')
    const deviceConfig = join(this.options.home, '.dearmachine', 'config', 'dearmachine.toml')
    const entryPoint = join(this.options.home, '.dearmachine', 'entrypoint', 'main')
    const run = async (label: string, command: readonly string[], cwd = this.options.workspace, stdin?: string): Promise<CommandResult> => {
      const request: CommandRequest = { label, command, cwd, environment }
      if (stdin !== undefined) request.stdin = stdin
      return await this.runner.run(request)
    }

    await mkdir(this.options.workspace, { recursive: true, mode: 0o700 })
    const selected = journalSelection(selection, existingInboxId)
    let journal = await loadJournal(this.options.journalPath)
    const loadedStage = journal?.stage
    if (journal === undefined) {
      if (await directoryHasEntries(join(this.options.home, '.dearmachine'))) {
        throw new Error('An existing Dear Machine installation was found. The installer will not change its pairs, inboxes, or running client automatically.')
      }
      if (await directoryHasEntries(join(this.options.home, '.machtiani'))) {
        throw new Error('An existing Machtiani configuration was found. The installer will not replace it automatically.')
      }
      const sourceStatus = (await run('Source checkout preflight', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
      journal = { version: 1, stage: 'started', selection: selected, sourceStatusHash: statusHash(sourceStatus) }
      await saveJournal(this.options.journalPath, journal)
    } else if (JSON.stringify(journal.selection) !== JSON.stringify(selected)) {
      throw new Error('The saved product installation belongs to different provider, model, transport, sender, or backend choices.')
    }

    const advance = async (stage: ProductStage, inboxAddress?: string): Promise<void> => {
      journal = { ...journal!, stage }
      if (inboxAddress !== undefined) journal.inboxAddress = inboxAddress
      await saveJournal(this.options.journalPath, journal)
    }

    if (!atLeast(journal.stage, 'machtiani-installed')) {
      await run('Install Machtiani', ['nix', 'run', `path:${harness}#install`, '--', '--no-interactive'], harness)
      await advance('machtiani-installed')
    }

    if (!atLeast(journal.stage, 'machtiani-configured')) {
      if (!await verifiedMachtianiConfig(machtianiConfigPath, provider, selection.model)) {
        await run('Configure Machtiani', [
          'machtiani', 'init', '--no-interactive', '--config-scope', 'global',
          '--preset', provider.preset, '--model', selection.model, '--alias', 'dearmachine', '--api-key-env', provider.variable,
        ], this.options.workspace)
        await requireMachtianiConfig(machtianiConfigPath, provider, selection.model)
      }
      await advance('machtiani-configured')
    }

    if (!atLeast(journal.stage, 'provider-verified')) {
      const providerCheckRoot = await prepareProviderCheckWorkspace(this.options.workspace, run)
      await run('Synchronize Machtiani provider check', ['machtiani', 'sync', '--model', 'dearmachine'], providerCheckRoot)
      const providerCheck = await run(
        'Check Machtiani provider',
        ['machtiani', 'run', '--model', 'dearmachine', '--mode', 'code', '-p', 'Reply with exactly MACHTIANI_PROVIDER_OK without changing files.'],
        providerCheckRoot,
        'c\n',
      )
      if (!providerCheck.stdout.includes('MACHTIANI_PROVIDER_OK')) throw new Error('Machtiani completed its live provider check without the expected confirmation.')
      await advance('provider-verified')
    }

    if (!atLeast(journal.stage, 'dearmachine-installed')) {
      await run('Install Dear Machine', ['nix', 'profile', 'install', `path:${dearMachine}#dearmachine`], dearMachine)
      await run('Verify installed commands', ['sh', '-c', 'command -v machtiani dearmachine agent-manager >/dev/null'])
      await advance('dearmachine-installed')
    }

    if (!atLeast(journal.stage, 'backend-configured')) {
      await run('Configure selected backend', ['dearmachine', 'setup-agents', '--backend', selection.backend.id], this.options.workspace, '\n')
      await writePrivate(deviceConfig, `version = 1\nbackends = [${JSON.stringify(selection.backend.id)}]\nresponse_tier = "formatted"\n`)
      await advance('backend-configured')
    }

    if (!atLeast(journal.stage, 'pair-created')) {
      if (loadedStage === 'pair-creation-started') {
        const recoveredStatus = await run('Inspect interrupted pair creation', ['dearmachine', 'status'])
        let recoveredInbox: string
        try { recoveredInbox = parseInbox(recoveredStatus.stdout, selection.authorizedSender, transport.id) } catch {
          throw new Error('Pair creation was interrupted before a matching local pair could be proven. The installer will not request another remote inbox automatically.')
        }
        if (!recoveredStatus.stdout.includes('DearMachine is running')) {
          await run('Restart recovered Dear Machine pair', ['dearmachine', 'up'])
          const restarted = await run('Verify restarted Dear Machine status', ['dearmachine', 'status'])
          if (!restarted.stdout.includes('DearMachine is running')) throw new Error('The recovered Dear Machine pair did not restart successfully.')
          recoveredInbox = parseInbox(restarted.stdout, selection.authorizedSender, transport.id)
        }
        await advance('pair-created', recoveredInbox)
      } else {
        await advance('pair-creation-started')
        const inboxArguments = existingInboxId === undefined ? ['--new-inbox'] : ['--inbox', existingInboxId]
        await run('Create Dear Machine pair', [
          'dearmachine', 'up', '--create', '--email', selection.authorizedSender,
          ...inboxArguments, '--transport', transport.id,
          '--project', entryPoint, '--entry-point-repo', entryPoint,
          '--config', deviceConfig, '--poll-interval', '5s', '--magnifica-humanitas', '--verbose',
        ])
        await advance('pair-created')
      }
    }

    const status = await run('Verify Dear Machine status', ['dearmachine', 'status'])
    if (!status.stdout.includes('DearMachine is running')) throw new Error('Dear Machine did not report a running native client.')
    const inboxAddress = parseInbox(status.stdout, selection.authorizedSender, transport.id)
    const backendCheck = await run('Verify selected backend', ['agent-manager', 'backend', 'health', selection.backend.id], entryPoint)
    if (!/(?:^|\n)result=ok(?:\n|$)/u.test(backendCheck.stdout)) throw new Error('The installed selected backend did not pass its functional health check.')
    const sourceAfter = (await run('Verify source checkout', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
    if (statusHash(sourceAfter) !== journal.sourceStatusHash) throw new Error('Product installation changed the source checkout; the installer stopped before verification could complete.')
    await advance('verified', inboxAddress)
    return { inboxAddress }
  }
}
