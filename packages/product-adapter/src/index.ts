import { protectPrivatePath, hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { ReadyInstallationSelection } from '@dearmachine/machtiani-installer-workflow'
export { loadDistribution, persistentModelHostCommand, type ProductDistribution, type InstallationMethod } from './distribution.ts'
import { persistentModelHostCommand, type ProductDistribution } from './distribution.ts'

export interface CommandRequest {
  label: string
  command: readonly string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  stdin?: string
  /** Null disables the per-command timeout for supervised durable work. */
  timeoutMs?: number | null
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
    const timer = request.timeoutMs === null
      ? undefined
      : setTimeout(() => controller.abort(), request.timeoutMs ?? 900_000)
    try {
      const result = await new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(request.command[0]!, request.command.slice(1), {
          cwd: request.cwd,
          env: request.environment,
          signal: controller.signal,
          windowsHide: true,
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
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

interface TransportSpec { id: string; variable: string; credentialPath: string }

const transports: Readonly<Record<string, Omit<TransportSpec, 'credentialPath'>>> = {
  agentmail: { id: 'agentmail', variable: 'AGENTMAIL_API_KEY_FILE' },
  openmail: { id: 'openmail', variable: 'OPENMAIL_API_KEY_FILE' },
  sendmux: { id: 'sendmux', variable: 'SENDMUX_API_KEY_FILE' },
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ')
}

function transportSpec(selection: string, home: string): TransportSpec {
  const spec = transports[normalized(selection)]
  if (spec === undefined) throw new Error(`Product installation does not yet support email transport ${selection}.`)
  return { ...spec, credentialPath: join(home, '.config', 'dearmachine', `${spec.id}-api-key`) }
}

async function privateRegularFile(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || !await hasPrivatePermissions(path) || !owned) {
      throw new Error(`${label} must be a nonempty private regular file owned by the current user`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} must be a nonempty private regular file owned by the current user`)
    }
    throw error
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
  await protectPrivatePath(dirname(path), 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await protectPrivatePath(temporary, 0o600)
  await rename(temporary, path)
}

function commandPath(environment: NodeJS.ProcessEnv, home: string): string {
  return [join(home, '.local', 'bin'), join(home, '.nix-profile', 'bin'), environment.PATH ?? ''].filter(Boolean).join(delimiter)
}

function nativeRunning(status: string): boolean {
  return /^(?:Dear Machine: running|DearMachine is running(?: \(PID \d+\))?\.?)\r?$/mu.test(status)
}

function parseInbox(status: string, sender: string, transport: string): string {
  const expectedSender = sender.trim().toLocaleLowerCase('en-US')
  for (const match of status.matchAll(/^Inbox: ([^\r\n]+)\r?\nAuthorized sender: ([^\r\n]+)\r?\nTransport: ([^\r\n]+)\r?$/gmu)) {
    if (match[2]?.trim().toLocaleLowerCase('en-US') === expectedSender && match[3]?.trim() === transport) {
      const address = match[1]?.trim()
      if (address) return address
    }
  }
  for (const line of status.split(/\r?\n/gu)) {
    const fields = line.split('\t')
    if (fields.length === 4 && fields[1]?.toLocaleLowerCase('en-US') === expectedSender && fields[3] === transport) {
      const address = fields[2]?.trim()
      if (address !== undefined && address !== '') return address
    }
  }
  throw new Error('Dear Machine started, but its registered inbox could not be verified.')
}

async function verifiedMachtianiConfig(path: string, profilePath: string, modelHostCommand: string, model: string, reasoningEffort?: string): Promise<boolean> {
  let content: string
  try { content = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const lines = new Set(content.split(/\r?\n/gu).map(line => line.trim()))
  const expected = [
    'default_model = "dearmachine"',
    `model = ${JSON.stringify(model)}`,
    'provider = "dearmachine-host"',
    'transport = "model-host"',
    `profile = ${JSON.stringify(profilePath)}`,
    `command = ${JSON.stringify(modelHostCommand)}`,
    'cache_enabled = true',
    'cache_key_name = "cache_control"',
    'cache_control = { type = "ephemeral" }',
    'cache_trigger_threshold = 4096',
    'cache_lookback_offset = 1',
  ]
  if (reasoningEffort !== undefined) expected.push(`effort = ${JSON.stringify(reasoningEffort)}`)
  if (!expected.every(line => lines.has(line))) {
    throw new Error('The installer-owned Machtiani configuration does not match the saved provider and model choices.')
  }
  return true
}

async function requireMachtianiConfig(path: string, profilePath: string, modelHostCommand: string, model: string, reasoningEffort?: string): Promise<void> {
  if (!await verifiedMachtianiConfig(path, profilePath, modelHostCommand, model, reasoningEffort)) {
    throw new Error('Machtiani configuration was not created.')
  }
}

export interface ProductInstallerOptions {
  /** Validated prebuilt release; omission retains the existing Nix route. */
  distribution?: ProductDistribution
  home: string
  sourceRoot: string
  workspace: string
  journalPath: string
  diagnosticPath?: string
  reasoningEffort?: string
  existingInboxId?: string
  liveEmailTimeoutMs?: number
  liveEmailPollMs?: number
  progress?(message: string): void
  environment?: NodeJS.ProcessEnv
  runner?: CommandRunner
  modelProfilePath?: string
}

export interface InstalledProducts { inboxAddress: string }

export type ProductStage =
  | 'started'
  | 'machtiani-installed'
  | 'model-host-installed'
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
  reasoningEffort?: string
  existingInboxIdHash?: string
}

interface ProductJournal {
  version: 1
  stage: ProductStage
  selection: JournalSelection
  sourceStatusHash: string
  inboxAddress?: string
  distributionManifest?: string
}

async function snapshotFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (relative: string): Promise<void> => {
    const path = join(root, relative)
    const metadata = await lstat(path)
    hash.update(JSON.stringify([relative, metadata.mode]))
    if (metadata.isSymbolicLink()) hash.update(JSON.stringify(await readlink(path)))
    else if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name))
    } else if (metadata.isFile()) hash.update(await readFile(path))
    else throw new Error('the release source contains an unsupported file')
  }
  await visit('')
  return hash.digest('hex')
}

const stages: readonly ProductStage[] = [
  'started', 'machtiani-installed', 'model-host-installed', 'machtiani-configured', 'provider-verified',
  'dearmachine-installed', 'backend-configured', 'pair-creation-started', 'pair-created', 'verified',
]

function atLeast(current: ProductStage, expected: ProductStage): boolean {
  return stages.indexOf(current) >= stages.indexOf(expected)
}

function journalSelection(selection: ReadyInstallationSelection, existingInboxId: string | undefined, reasoningEffort: string | undefined): JournalSelection {
  const result: JournalSelection = {
    provider: selection.provider,
    model: selection.model,
    transport: selection.transport,
    authorizedSender: selection.authorizedSender,
    backendId: selection.backend.id,
  }
  if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort
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
    if (!metadata.isFile() || metadata.isSymbolicLink() || !await hasPrivatePermissions(path) || !owned) {
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

  async captureLiveEmailBaseline(): Promise<string> {
    const metadata = await this.liveEmailLogMetadata()
    return JSON.stringify({ version: 1, device: String(metadata.dev), inode: String(metadata.ino), size: metadata.size })
  }

  async waitForLiveEmail(baselineValue: string, progress: (message: string) => void): Promise<void> {
    let baseline: { version: number; device: string; inode: string; size: number }
    try { baseline = JSON.parse(baselineValue) as typeof baseline } catch { throw new Error('the saved live email baseline is invalid') }
    if (baseline.version !== 1 || !/^\d+$/u.test(baseline.device) || !/^\d+$/u.test(baseline.inode) ||
      !Number.isSafeInteger(baseline.size) || baseline.size < 0) {
      throw new Error('the saved live email baseline is invalid')
    }
    const deadline = Date.now() + (this.options.liveEmailTimeoutMs ?? 1_200_000)
    const pollMs = this.options.liveEmailPollMs ?? 2_000
    let received = false
    let working = false
    let lastUpdate = Date.now()
    while (Date.now() < deadline) {
      const metadata = await this.liveEmailLogMetadata()
      if (String(metadata.dev) !== baseline.device || String(metadata.ino) !== baseline.inode || metadata.size < baseline.size) {
        throw new Error('Dear Machine replaced or truncated its live log during email verification.')
      }
      const log = await readFile(join(this.options.home, '.dearmachine', 'log', 'dearmachine.log'))
      const activity = log.subarray(baseline.size).toString('utf8')
      if (!received && /poll: [1-9]\d* unread messages?/u.test(activity)) {
        received = true
        lastUpdate = Date.now()
        progress('Dear Machine received your email')
      }
      if (/processed message=.* result=answer(?:\r?\n|$)/u.test(activity)) {
        progress('Dear Machine sent the reply')
        return
      }
      if (/processed message=.* result=(?!answer(?:\r?\n|$))[^\s]+/u.test(activity)) {
        throw new Error('Dear Machine processed the test email without producing a reply.')
      }
      if (received && !working) {
        working = true
        lastUpdate = Date.now()
        progress('Dear Machine is working through the selected backend')
      } else if (Date.now() - lastUpdate >= 60_000) {
        lastUpdate = Date.now()
        progress(received
          ? 'Dear Machine is still working through the selected backend'
          : 'Still waiting for the test email to arrive')
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    throw new Error('Dear Machine did not send the live test reply within 20 minutes.')
  }

  private async liveEmailLogMetadata() {
    const path = join(this.options.home, '.dearmachine', 'log', 'dearmachine.log')
    const metadata = await lstat(path)
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || !owned || !await hasPrivatePermissions(path, 0o022)) {
      throw new Error('Dear Machine live verification requires an owned, non-writable-by-others regular log file.')
    }
    return metadata
  }

  async install(selection: ReadyInstallationSelection): Promise<InstalledProducts> {
    const distribution = this.options.distribution
    if (distribution !== undefined && distribution.sourceRoot !== this.options.sourceRoot) throw new Error('the distribution source root does not match')
    if (selection.backend.status !== 'ready') throw new Error(`${selection.backend.name} must pass its readiness check before product installation.`)
    const existingInboxId = this.options.existingInboxId
    if (existingInboxId !== undefined && (existingInboxId.trim() === '' || /[\r\n\0]/u.test(existingInboxId))) {
      throw new Error('The pre-provisioned inbox ID is invalid.')
    }
    const reasoningEffort = this.options.reasoningEffort
    if (reasoningEffort !== undefined && (reasoningEffort.trim() === '' || /[\r\n\0]/u.test(reasoningEffort))) {
      throw new Error('The reasoning effort is invalid.')
    }
    const modelProfilePath = this.options.modelProfilePath ?? join(this.options.home, '.config', 'machtiani', 'model-profile.json')
    const transport = transportSpec(selection.transport, this.options.home)
    await privateRegularFile(modelProfilePath, 'shared model profile')
    await privateRegularFile(transport.credentialPath, 'transport credential')

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.environment,
      HOME: this.options.home,
      PATH: commandPath({ ...process.env, ...this.options.environment }, this.options.home),
      [transport.variable]: transport.credentialPath,
      DEARMACHINE_BACKENDS: JSON.stringify([selection.backend.id]),
    }
    const sourceHasGit = distribution === undefined && await lstat(join(this.options.sourceRoot, '.git')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })
    const machtianiConfigPath = join(this.options.home, '.config', 'dearmachine', 'machtiani', 'config.toml')
    const modelHostCommand = distribution === undefined ? join(this.options.home, '.local', 'bin', 'machtiani-model-host') : persistentModelHostCommand(distribution, environment)
    const deviceConfig = join(this.options.home, '.dearmachine', 'config', 'dearmachine.toml')
    const entryPoint = join(this.options.home, '.dearmachine', 'entrypoint', 'main')
    environment.MACHTIANI_CONFIG = machtianiConfigPath
    const run = async (label: string, command: readonly string[], cwd = this.options.workspace, stdin?: string, timeoutMs?: number | null): Promise<CommandResult> => {
      if (distribution !== undefined) {
        const commands: Record<string, string> = { dearmachine: distribution.binaries.dearmachine, machtiani: distribution.binaries.machtiani,
          'agent-manager': distribution.binaries.agentManager }
        const executable = commands[command[0] ?? '']
        if (executable !== undefined) command = [executable, ...command.slice(1)]
      }
      const request: CommandRequest = { label, command, cwd, environment, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
      if (stdin !== undefined) request.stdin = stdin
      try {
        this.options.progress?.(label)
        return await this.runner.run(request)
      } catch (error) {
        if (error instanceof CommandExecutionError && this.options.diagnosticPath !== undefined) {
          const captured = error.privateDiagnostic()
          const redact = (value: string): string => value.replace(/(?:sk-or-v1-|sk-)[A-Za-z0-9_-]+|[A-Za-z0-9_-]*secret[A-Za-z0-9_-]*/giu, '[REDACTED]')
          await writePrivate(this.options.diagnosticPath, `${JSON.stringify({
            label: error.label,
            code: error.code,
            stdout: redact(captured.stdout),
            stderr: redact(captured.stderr),
          }, undefined, 2)}\n`)
        }
        throw error
      }
    }

    await mkdir(this.options.workspace, { recursive: true, mode: 0o700 })
    const selected = journalSelection(selection, existingInboxId, reasoningEffort)
    let journal = await loadJournal(this.options.journalPath)
    const loadedStage = journal?.stage
    if (journal === undefined) {
      if (await directoryHasEntries(join(this.options.home, '.dearmachine'))) {
        throw new Error('An existing Dear Machine installation was found. The installer will not change its pairs, inboxes, or running client automatically.')
      }
      const sourceStatus = sourceHasGit
        ? (await run('Source checkout preflight', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
        : await snapshotFingerprint(this.options.sourceRoot)
      journal = { version: 1, stage: 'started', selection: selected, sourceStatusHash: statusHash(sourceStatus) }
      if (distribution !== undefined) journal.distributionManifest = distribution.manifestPath
      await saveJournal(this.options.journalPath, journal)
    } else if (JSON.stringify(journal.selection) !== JSON.stringify(selected)) {
      throw new Error('The saved product installation belongs to different provider, model, transport, sender, or backend choices.')
    }
    if (journal.distributionManifest !== distribution?.manifestPath) throw new Error('the saved installation method or distribution differs; automatic migration is not allowed')

    const advance = async (stage: ProductStage, inboxAddress?: string): Promise<void> => {
      journal = { ...journal!, stage }
      if (inboxAddress !== undefined) journal.inboxAddress = inboxAddress
      await saveJournal(this.options.journalPath, journal)
    }

    if (!atLeast(journal.stage, 'machtiani-installed')) {
      if (distribution === undefined) {
        await run('Install coordinated release', [process.execPath, fileURLToPath(new URL('../../app/dist/bin.mjs', import.meta.url)), 'install', '--source-root', this.options.sourceRoot], this.options.sourceRoot)
      }
      else await run('Verify supplied Machtiani', ['machtiani', '--version'])
      await advance('machtiani-installed')
    }

    if (!atLeast(journal.stage, 'model-host-installed')) {
      await run('Verify shared model host', process.platform === 'win32' ? [modelHostCommand, '--help'] : ['sh', '-c', 'test -x "$1"', 'verify-model-host', modelHostCommand])
      await advance('model-host-installed')
    }

    if (!atLeast(journal.stage, 'machtiani-configured')) {
      if (!await verifiedMachtianiConfig(machtianiConfigPath, modelProfilePath, modelHostCommand, selection.model, reasoningEffort)) {
        const config = `default_model = "dearmachine"\nshell_agent_model = "dearmachine"\nanswer_model = "dearmachine"\nfile_discovery_model = "dearmachine"\n\n[model_defaults]\ncache_enabled = true\ncache_key_name = "cache_control"\ncache_control = { type = "ephemeral" }\ncache_trigger_threshold = 4096\ncache_lookback_offset = 1\n\n[providers.dearmachine-host]\ntransport = "model-host"\nprofile = ${JSON.stringify(modelProfilePath)}\ncommand = ${JSON.stringify(modelHostCommand)}\n\n[models.dearmachine]\nprovider = "dearmachine-host"\nmodel = ${JSON.stringify(selection.model)}\ncontext_length = 131072\n${reasoningEffort === undefined ? '' : `\n[models.dearmachine.params.reasoning]\neffort = ${JSON.stringify(reasoningEffort)}\n`}`
        await writePrivate(machtianiConfigPath, config)
        await run('Check Machtiani configuration', ['machtiani', 'config', 'check'], this.options.workspace)
        await requireMachtianiConfig(machtianiConfigPath, modelProfilePath, modelHostCommand, selection.model, reasoningEffort)
      }
      await advance('machtiani-configured')
    }

    if (!atLeast(journal.stage, 'provider-verified')) {
      const verification = await run('Verify Machtiani model roles', ['machtiani', 'verify', '--json'])
      requireMachtianiVerificationReport(verification.stdout)
      await advance('provider-verified')
    }

    if (!atLeast(journal.stage, 'dearmachine-installed')) {
      if (distribution === undefined) {
        await run('Verify installed commands', ['sh', '-c', 'command -v machtiani dearmachine agent-manager >/dev/null'])
      } else {
        await run('Verify supplied Dear Machine', ['dearmachine', '--help'])
        await run('Verify supplied Agent Manager', ['agent-manager', '--help'])
      }
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
        if (!nativeRunning(recoveredStatus.stdout)) {
          await run('Restart recovered Dear Machine pair', ['dearmachine', 'up'])
          const restarted = await run('Verify restarted Dear Machine status', ['dearmachine', 'status'])
          if (!nativeRunning(restarted.stdout)) throw new Error('The recovered Dear Machine pair did not restart successfully.')
          recoveredInbox = parseInbox(restarted.stdout, selection.authorizedSender, transport.id)
        }
        await advance('pair-created', recoveredInbox)
      } else {
        await advance('pair-creation-started')
        const inboxArguments = existingInboxId === undefined ? ['--new-inbox'] : ['--inbox', existingInboxId]
        await run('Create Dear Machine pair', [
          'dearmachine', 'up', '--create', '--resume', '--email', selection.authorizedSender,
          ...inboxArguments, '--transport', transport.id,
          ...(distribution === undefined ? ['--agent-bin', join(this.options.home, '.local/bin/machtiani'), '--agent-manager', join(this.options.home, '.local/bin/agent-manager')] : []),
          '--project', entryPoint, '--entry-point-repo', entryPoint,
          '--config', deviceConfig, '--poll-interval', '5s', '--magnifica-humanitas', '--verbose',
        ], this.options.workspace, undefined, null)
        await advance('pair-created')
      }
    }

    const status = await run('Verify Dear Machine status', ['dearmachine', 'status'])
    if (!nativeRunning(status.stdout)) throw new Error('Dear Machine did not report a running native client.')
    const inboxAddress = parseInbox(status.stdout, selection.authorizedSender, transport.id)
    const backendCheck = await run('Verify selected backend', ['agent-manager', 'backend', 'health', selection.backend.id], entryPoint)
    if (!/(?:^|\n)result=ok(?:\n|$)/u.test(backendCheck.stdout)) throw new Error('The installed selected backend did not pass its functional health check.')
    const sourceAfter = sourceHasGit
      ? (await run('Verify source checkout', ['git', '-C', this.options.sourceRoot, 'status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none'])).stdout
      : await snapshotFingerprint(this.options.sourceRoot)
    if (statusHash(sourceAfter) !== journal.sourceStatusHash) throw new Error('Product installation changed the source checkout; the installer stopped before verification could complete.')
    await advance('verified', inboxAddress)
    return { inboxAddress }
  }
}

function requireMachtianiVerificationReport(stdout: string): void {
  let report: { version?: unknown; status?: unknown; roles?: unknown }
  try { report = JSON.parse(stdout) as typeof report } catch {
    throw new Error('Machtiani model-role verification returned an invalid report.')
  }
  const roles = Array.isArray(report.roles) ? report.roles : []
  const names = roles.map(role => (role as { role?: unknown }).role)
  const expected = ['planner', 'shell-agent', 'answer', 'file-discovery']
  if (report.version !== 1 || report.status !== 'ok' || names.length !== expected.length || expected.some((name, index) => names[index] !== name)) {
    throw new Error('Machtiani did not verify every configured model role.')
  }
}

export { ManagedNix, UnsupportedManagedInstallationError, type ManagedRelease, type ManagedRun } from './managed-nix.ts'
export { launcherGuidance } from './launcher-guidance.ts'
