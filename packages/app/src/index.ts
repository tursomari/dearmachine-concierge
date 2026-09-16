import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import { InstallerTui, assertInteractiveTerminal } from '@dearmachine/machtiani-installer-tui'
import { messages, runFirstThreeStages, type CheckpointPort, type WorkflowCheckpoint } from '@dearmachine/machtiani-installer-workflow'
import { CredentialFileAdapter } from '@dearmachine/machtiani-installer-credentials'
import {
  DshAgentSession,
  InstallerModelSetup,
  type InstallerAgentEvent,
  type InstallerModelSelection,
} from '@dearmachine/machtiani-installer-dsh-adapter'
import type { InstallationOutcome } from '@dearmachine/machtiani-installer-dsh-adapter/installer-tools'
import { CredentialBridge, credentialSocketPath } from './credential-bridge.ts'
import { credentialRuntimeContext } from './credential-context.ts'
import { acquireInstallerLock } from './lock.ts'
import { runInstallerModelWizard } from './model-wizard.ts'
import { ConciergeShell, conciergeInterruptHint } from './concierge-shell.ts'
import { nativeSupervisionChoice, defaultConciergeControl } from './concierge-control.ts'
import { saveModelHostProfile } from '@dearmachine/machtiani-model-host'
import { resolveSourceReference, saveSourceReference, type SourceReference } from './source-reference.ts'
import { buildContainerDistribution } from './container-build.ts'
import { runInstallationWizard } from './installation-wizard.ts'
import { saveInterfacePreferences } from './interface-preferences.ts'
import { submitInstallerMessage, type InstallerAssistantState } from './installer-conversation.ts'
import { assistantModelPath, changeAssistantModel } from './assistant-model.ts'
import { loadDistribution, type InstallationMethod, type ProductDistribution } from '@dearmachine/machtiani-installer-products'

export interface InstallerPaths { stateDirectory: string; workspace: string }

export function defaultInstallerPaths(environment: NodeJS.ProcessEnv = process.env): InstallerPaths {
  const home = environment.HOME
  if (home === undefined || home === '') throw new Error('HOME is required to locate the isolated installer workspace')
  const stateRoot = environment.XDG_STATE_HOME || join(home, '.local', 'state')
  const dataRoot = environment.XDG_DATA_HOME || join(home, '.local', 'share')
  return {
    stateDirectory: join(stateRoot, 'machtiani-installer'),
    workspace: join(dataRoot, 'machtiani-installer', 'workspace'),
  }
}

function checkpointStore(path: string): CheckpointPort {
  return {
    load: async () => {
      try { return JSON.parse(await readFile(path, 'utf8')) as WorkflowCheckpoint } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    save: async checkpoint => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(checkpoint, undefined, 2)}\n`, { mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

function redactInstallerDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[REDACTED]')
}

export async function retainInstallerAgentDiagnostic(
  path: string,
  error: unknown,
  diagnostic: { stderr: string },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    recordedAt: new Date().toISOString(),
    error: redactInstallerDiagnostic(errorMessage),
    stderr: redactInstallerDiagnostic(diagnostic.stderr),
  }, undefined, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function validatedSourceRoot(sourceRoot: string): Promise<string> {
  if (!isAbsolute(sourceRoot)) throw new Error('--source-root must be an absolute path to the Machtiani umbrella checkout')
  const resolved = await realpath(sourceRoot)
  for (const component of ['machtiani-harness', 'dearmachine']) {
    const metadata = await stat(join(resolved, component))
    if (!metadata.isDirectory()) throw new Error(`${resolved} does not contain the ${component} component checkout`)
  }
  return resolved
}

function conversation(tui: InstallerTui, preview = false) {
  return {
    ask: (message: string) => tui.ask({ message }),
    askSecret: (message: string) => tui.askSecret(preview
      ? `Preview only: this demonstrates the masked credential field. Type any placeholder and press Enter; it will not be saved.\n\n${message}`
      : message),
    say: (message: string) => tui.addAssistant(message),
    progress: (message: string | undefined) => tui.setProgress(message),
    tool: (name: string, detail: string) => tui.beginTool(name, detail),
  }
}

export async function runMockInstaller(paths = defaultInstallerPaths()): Promise<void> {
  assertInteractiveTerminal()
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  let requestExit!: () => void
  const exitRequested = new Promise<void>(resolve => { requestExit = resolve })
  const tui = new InstallerTui({ onExit: requestExit })
  const checkpointPath = join(paths.stateDirectory, 'preview-checkpoint.json')
  let workflow: ReturnType<typeof runFirstThreeStages> | undefined
  try {
    tui.start()
    workflow = runFirstThreeStages({
      conversation: conversation(tui, true),
      environment: {
        inspect: async () => ({ missingFoundations: [], detectedBackends: [] }),
        installFoundations: async () => { throw new Error('the no-mutation preview cannot install dependencies') },
      },
      credentials: {
        prepare: async () => 'pending',
        save: async () => {},
      },
      checkpoint: checkpointStore(checkpointPath),
    })
    const result = await Promise.race([workflow, exitRequested.then(() => undefined)])
    if (result !== undefined) tui.addAssistant('The no-change installation preview is complete. No products or credentials were installed.')
  } finally {
    await tui.dispose()
    await workflow?.catch(() => {})
    await lock.release()
  }
}

export function installerAgentPrompt(
  credentialHelper: string,
  selection: InstallerModelSelection,
  modelProfilePath: string,
  sourceReference: SourceReference,
  installation: { method: InstallationMethod; distribution?: ProductDistribution } = { method: 'nix' },
): string {
  const runtimeContext = {
    installation: { ...installation, ...(installation.method === 'nix' ? {
      acquisitionCommand: [process.execPath, fileURLToPath(new URL('./bin.mjs', import.meta.url)),
        'install', '--source-root', sourceReference.sourceRoot],
    } : {}) },
    documentation: sourceReference,
    sharedModelSelection: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      profile: modelProfilePath,
    },
    ...credentialRuntimeContext(credentialHelper),
  }
  return `<runtime_context_json>\n${JSON.stringify(runtimeContext, undefined, 2)}\n</runtime_context_json>\n\nThe launcher steps are complete. Begin with Stage 1 now.`
}

async function waitForInstallationOutcome(path: string, signal: AbortSignal): Promise<InstallationOutcome> {
  while (!signal.aborted) {
    try {
      const metadata = await lstat(path)
      const owned = process.getuid === undefined || metadata.uid === process.getuid()
      if (!metadata.isFile() || metadata.isSymbolicLink() || !owned || (metadata.mode & 0o077) !== 0) {
        throw new Error('installer outcome must be an owned private regular file')
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstallationOutcome>
      if (value.version !== 1 || !['success', 'partial', 'blocked'].includes(value.outcome ?? '') ||
        typeof value.summary !== 'string' || !Array.isArray(value.receipts) || !value.receipts.every(receipt => typeof receipt === 'string')) {
        throw new Error('installer outcome is invalid')
      }
      return value as InstallationOutcome
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>(resolve => {
      const finish = () => {
        signal.removeEventListener('abort', aborted)
        resolve()
      }
      const timer = setTimeout(finish, 100)
      timer.unref()
      const aborted = () => { clearTimeout(timer); resolve() }
      signal.addEventListener('abort', aborted, { once: true })
    })
  }
  throw new Error('installer outcome wait was cancelled')
}

function renderInstallationOutcome(outcome: InstallationOutcome): string {
  const heading = `Installation outcome — ${outcome.outcome.toLocaleUpperCase('en-US')}`
  const receipts = outcome.receipts.length === 0 ? '' : `\n\n${outcome.receipts.map(receipt => `- ${receipt}`).join('\n')}`
  const remaining = outcome.remainingAction === undefined ? '' : `\n\nNext: ${outcome.remainingAction}`
  return `${heading}\n\n${outcome.summary}${receipts}${remaining}`
}

export const installationProgressLabel = 'Machtiani installation in progress'

interface AgentEventTui {
  addCommand?(command: string): void
  addAssistant(message: string): void
  addReasoning(message: string): void
  beginTool(name: string, detail: string): ReturnType<InstallerTui['beginTool']>
}

export interface AgentToolActivityState {
  activity: ReturnType<InstallerTui['beginTool']>
  detail: string
}

export function renderAgentEvent(tui: AgentEventTui, tools: Map<string, AgentToolActivityState>, event: InstallerAgentEvent): void {
  switch (event.type) {
    case 'assistant-stream':
      break
    case 'assistant':
      // Model deliberation is not user guidance. Keep the normal installer
      // conversation as focused as the concierge; tool summaries remain visible.
      if (event.text.trim() !== '') tui.addAssistant(event.text)
      break
    case 'tool-start':
      tools.set(event.id, { activity: tui.beginTool(event.name, event.detail), detail: event.detail })
      if (event.command !== undefined) tui.addCommand?.(event.command)
      break
    case 'tool-end': {
      const tool = tools.get(event.id)
      tools.delete(event.id)
      if (event.failed) tool?.activity.fail(`${tool.detail} — Failed`)
      else tool?.activity.succeed(tool.detail)
      break
    }
    case 'turn-end':
      {
        const message = installerTurnMessage(event)
        if (message !== undefined) tui.addAssistant(message)
      }
      break
  }
}

export function installerTurnMessage(event: Extract<InstallerAgentEvent, { type: 'turn-end' }>): string | undefined {
  if (event.outcome === 'completed') return undefined
  if (event.outcome === 'error' && event.failureCode === 'TIMEOUT') {
    return 'The installer model provider timed out after several attempts. Type “try again” to retry in this window, or use /help for local controls.'
  }
  if (event.outcome === 'error' && event.failureCode === 'RATE_LIMIT') {
    return 'The installer model provider is temporarily rate-limited. Wait a moment, then type “try again”, or use /help for local controls.'
  }
  if (event.outcome === 'error' && event.failureCode === 'EMPTY_RESPONSE') {
    return 'The model returned no answer after several attempts. Type “try again” to continue in this window, or use /help for local controls.'
  }
  if (event.outcome === 'error' && (event.failureCode === 'SERVER' || event.failureCode === 'TRANSPORT')) {
    return 'The installer model provider had a temporary connection problem. Type “try again” to retry in this window, or use /help for local controls.'
  }
  if (event.outcome === 'max-tokens') {
    return 'The installer model reached its turn limit before finishing. Ask it to continue, or use /help for local controls.'
  }
  if (event.outcome === 'aborted') {
    return 'The current installer turn was cancelled. You can continue in this window, or use /help for local controls.'
  }
  if (event.outcome === 'blocked') {
    return 'The installer needs more information before it can continue. Reply with the requested detail, or use /help for local controls.'
  }
  return 'The installer model could not complete this turn. Type “try again” to retry in this window, or use /help for local controls.'
}

/** Runs one DSH agent that conducts the published installation contract. */
export async function runInstaller(sourceRoot: string, paths = defaultInstallerPaths()): Promise<void> {
  assertInteractiveTerminal()
  const dshHome = join(paths.stateDirectory, 'dsh')
  let source = await validatedSourceRoot(sourceRoot)
  const home = process.env.HOME
  if (home === undefined || home === '') throw new Error('HOME is required to run the installer agent')
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  let requestExit!: () => void
  const exitRequested = new Promise<void>(resolve => { requestExit = resolve })
  let agent: DshAgentSession | undefined
  let assistantState: InstallerAssistantState = 'setup'
  const lifetime = new AbortController()
  let modelChange: Promise<void> | undefined
  let building: AbortController | undefined
  let setup: InstallerModelSetup | undefined
  let wizard: Promise<InstallerModelSelection> | undefined
  const tools = new Map<string, AgentToolActivityState>()
  let shell!: ConciergeShell
  const tui = new InstallerTui({
    onLocalCommand: text => shell.submit(text),
    exitWindowMs: 2_000, interruptHint: conciergeInterruptHint,
    onSubmit: text => shell.submit(text),
    onInterrupt: async () => { if (building) building.abort(); else await agent?.interrupt() },
    onExit: () => { void shell.submit('/quit') },
  })
  shell = new ConciergeShell({
    chooseSupervision: nativeSupervisionChoice,
    control: defaultConciergeControl(),
    say: text => tui.addAssistant(text),
    converse: async text => { await submitInstallerMessage(text, assistantState, agent, message => tui.addAssistant(message)) },
    ensureIndependent: async () => {}, unsubscribe: async () => {},
    changeModel: async () => {
      if (assistantState !== 'ready' || agent === undefined) {
        tui.addAssistant('Choose the initial model in the setup menus first. Use /model once the assistant conversation is running.')
        return
      }
      modelChange = changeAssistantModel(tui, { home, signal: lifetime.signal, pause: () => agent!.pause() })
      await modelChange
    },
    close: async () => { lifetime.abort(); building?.abort(); requestExit() },
  })
  const credentials = new CredentialFileAdapter({ home })
  const socketPath = credentialSocketPath(paths.stateDirectory)
  const bridge = new CredentialBridge({ socketPath, tui, credentials })
  const credentialHelper = fileURLToPath(new URL('./credential-bin.mjs', import.meta.url))
  const outcomePath = join(paths.stateDirectory, 'installation-outcome.json')
  const diagnosticPath = join(paths.stateDirectory, 'installation-assistant-diagnostic.json')
  const outcomeWait = new AbortController()
  try {
    tui.start()
    let distribution = await loadDistribution(process.env)
    if (distribution !== undefined && distribution.sourceRoot !== source) throw new Error('the distribution does not match the installer source root')
    const credentialPath = join(home, '.config', 'dearmachine', 'backends.env')
    const modelProfilePath = join(home, '.config', 'machtiani', 'model-profile.json')
    const modelSetup = async (): Promise<InstallerModelSetup> => {
      if (setup === undefined) {
        tui.setProgress('Loading installer model choices')
        setup = await InstallerModelSetup.open(dshHome, process.env, { credentialPath, home })
        tui.setProgress(undefined)
      }
      return setup
    }
    const configured = await runInstallationWizard(tui, distribution !== undefined, exitRequested, async () => {
      wizard = runInstallerModelWizard(tui, await modelSetup())
      return await wizard
    }, async method => {
      if (method !== 'container' || distribution?.method === 'container') return
      building = new AbortController()
      tui.setProgress('Building Dear Machine with Docker; the first build downloads its dependencies. Ctrl+C cancels.')
      try {
        distribution = await buildContainerDistribution({ sourceRoot: source,
          diagnosticPath: join(paths.stateDirectory, 'container-build.log'), signal: building.signal })
      } finally { building = undefined; tui.setProgress(undefined) }
    })
    if (configured === undefined) return
    const { selection, method, showCommands } = configured
    if (method === 'container' && distribution) source = distribution.sourceRoot
    await saveInterfacePreferences(home, { showCommands }).catch(() => {
      tui.addAssistant('Your command-display choice applies to this installation, but could not be saved for future conversations.')
    })
    const configuredSetup = await modelSetup()
    await saveModelHostProfile(modelProfilePath, configuredSetup.profileFor(selection))
    await saveModelHostProfile(assistantModelPath(home), configuredSetup.profileFor(selection))
    const sourceReference = await resolveSourceReference(source)
    await saveSourceReference(home, sourceReference)
    await configuredSetup.close()
    setup = undefined
    tui.setProgress('Starting the installation assistant')
    await bridge.start()
    await unlink(outcomePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    agent = new DshAgentSession({
      showCommands,
      dshHome,
      workspace: source,
      selection,
      modelProfilePath: assistantModelPath(home),
      outcomePath,
      environment: {
        MACHTIANI_INSTALLER_CONTRACT: join(source, 'INSTALL.md'),
        MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: socketPath,
        MACHTIANI_INSTALL_METHOD: method,
        ...(method === 'container' && distribution ? { MACHTIANI_DISTRIBUTION: distribution.manifestPath,
          PATH: `${dirname(distribution.binaries.dearmachine)}:${process.env.PATH ?? ''}` } : {}),
      },
      onEvent: event => { renderAgentEvent(tui, tools, event) },
      onStatus: status => { tui.setProgress(status === 'running' ? installationProgressLabel : undefined) },
    })
    await agent.start()
    assistantState = 'ready'
    await agent.prompt(installerAgentPrompt(credentialHelper, selection, modelProfilePath, sourceReference, {
      method, ...(method === 'nix' || distribution === undefined ? {} : { distribution }),
    }))
    const completion = await Promise.race([
      exitRequested.then(() => ({ kind: 'exit' as const })),
      agent.whenExited().then(exitCode => ({ kind: 'agent-exit' as const, exitCode })),
      waitForInstallationOutcome(outcomePath, outcomeWait.signal).then(outcome => ({ kind: 'outcome' as const, outcome })),
    ])
    if (completion.kind === 'agent-exit') throw new Error(`The installation assistant exited unexpectedly (${completion.exitCode ?? 'unknown'}).`)
    if (completion.kind === 'outcome') {
      tui.setProgress(undefined)
      tui.addAssistant(renderInstallationOutcome(completion.outcome))
    }
  } catch (error) {
    assistantState = 'unavailable'
    const retained = await retainInstallerAgentDiagnostic(diagnosticPath, error, agent?.privateDiagnostic() ?? { stderr: '' })
      .then(() => true, () => false)
    tui.setProgress(undefined)
    tui.addAssistant(`The installation assistant could not continue.${retained ? ` A private diagnostic was saved to ${diagnosticPath}.` : ''} Use /help for local controls and recovery commands, or /quit to close this interface.`)
    await exitRequested
  } finally {
    lifetime.abort()
    outcomeWait.abort()
    tui.setProgress(undefined)
    await agent?.shutdown().catch(() => {})
    await tui.dispose()
    await modelChange?.catch(() => {})
    await wizard?.catch(() => {})
    await setup?.close().catch(() => {})
    await bridge.close()
    await lock.release()
  }
}

export { acquireInstallerLock, InstallerAlreadyRunningError } from './lock.ts'
export { validatedSourceRoot }
export { runInstallerModelWizard } from './model-wizard.ts'
