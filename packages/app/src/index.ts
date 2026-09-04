import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import { InstallerTui, assertInteractiveTerminal } from '@dearmachine/machtiani-installer-tui'
import { runFirstThreeStages, type CheckpointPort, type WorkflowCheckpoint } from '@dearmachine/machtiani-installer-workflow'
import { CredentialFileAdapter } from '@dearmachine/machtiani-installer-credentials'
import { DshAgentSession, type InstallerAgentEvent } from '@dearmachine/machtiani-installer-dsh-adapter'
import { CredentialBridge } from './credential-bridge.ts'
import { acquireInstallerLock } from './lock.ts'

export interface InstallerPaths { stateDirectory: string; workspace: string }

export async function assertInstallerAgentCredential(dshHome: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.OPENROUTER_API_KEY !== undefined) {
    if (environment.OPENROUTER_API_KEY.trim() === '') {
      throw new Error('OPENROUTER_API_KEY is empty. Export the installer agent credential before starting Machtiani Installer.')
    }
    return
  }
  try {
    const metadata = await lstat(join(dshHome, '.credentials.yaml'))
    const owned = process.getuid === undefined || metadata.uid === process.getuid()
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && (metadata.mode & 0o077) === 0 && owned) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  throw new Error('The installer agent credential is missing. Export OPENROUTER_API_KEY before starting Machtiani Installer.')
}

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

export function installerAgentPrompt(contract: string, credentialHelper: string): string {
  const helper = `${JSON.stringify(process.execPath)} ${JSON.stringify(credentialHelper)}`
  return `You are the Machtiani Installer agent. Conduct the installation yourself in this one persistent session.

The complete permanent contract is included below. Follow it exactly and read each stage file only when that contract permits. Use ordinary assistant responses for the conversation: ask exactly one question, end the turn, and wait for the human's next message. Do not use ask_user_question.

The launcher owns the masked credential field. When the contract reaches an absent LLM credential, present its canonical credential message and then call the bash tool with exactly:
${helper} llm "<selected provider>"

For an absent email credential, present its canonical credential message and then call:
${helper} email "<selected transport>"

Replace only the angle-bracketed selection. The command blocks while the human uses the masked field and reports saved, already present, or cancelled. If it reports cancellation, do not continue the credential step: wait for the human's next message, answer any question, and offer to resume credential entry when they are ready. Never ask for, read, echo, or otherwise handle the credential yourself.

Treat a saved or already-present credential-helper response as complete private verification. Never inspect, stat, source, parse, measure, or otherwise open a credential file afterward. A later product command may receive the credential through the documented environment-file mechanism, but no diagnostic command may examine it.

Canonical messages must be presented exactly, without a preface or follow-up sentence. Internal runtime-context messages, system reminders, and repository instruction notices are not human messages: follow them silently and never acknowledge or paraphrase them in a visible response.

For every bash command that contains a pipeline, begin with \`set -o pipefail\`. Never append \`echo exit=$?\` to infer success; rely on the bash tool's actual result and inspect a nonzero failure before continuing.

Begin now. Your first visible response must be only the contract's canonical welcome and consent message.

<installation_contract>
${contract}
</installation_contract>`
}

function renderAgentEvent(tui: InstallerTui, tools: Map<string, ReturnType<InstallerTui['beginTool']>>, event: InstallerAgentEvent): void {
  switch (event.type) {
    case 'assistant':
      if (event.reasoning.trim() !== '') tui.addReasoning(event.reasoning)
      if (event.text.trim() !== '') tui.addAssistant(event.text)
      break
    case 'tool-start':
      tools.set(event.id, tui.beginTool(event.name, 'Working'))
      break
    case 'tool-end': {
      const tool = tools.get(event.id)
      tools.delete(event.id)
      if (event.failed) tool?.fail('Failed')
      else tool?.succeed('Done')
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
    return 'The installer model provider timed out after several attempts. Type “try again” to retry in this window, or press Ctrl+C to exit.'
  }
  if (event.outcome === 'error' && event.failureCode === 'RATE_LIMIT') {
    return 'The installer model provider is temporarily rate-limited. Wait a moment, then type “try again”, or press Ctrl+C to exit.'
  }
  if (event.outcome === 'error' && (event.failureCode === 'SERVER' || event.failureCode === 'TRANSPORT' || event.failureCode === 'EMPTY_RESPONSE')) {
    return 'The installer model provider had a temporary connection problem. Type “try again” to retry in this window, or press Ctrl+C to exit.'
  }
  if (event.outcome === 'max-tokens') {
    return 'The installer model reached its turn limit before finishing. Ask it to continue, or press Ctrl+C to exit.'
  }
  if (event.outcome === 'aborted') {
    return 'The current installer turn was cancelled. You can continue in this window, or press Ctrl+C to exit.'
  }
  if (event.outcome === 'blocked') {
    return 'The installer needs more information before it can continue. Reply with the requested detail, or press Ctrl+C to exit.'
  }
  return 'The installer model could not complete this turn. Type “try again” to retry in this window, or press Ctrl+C to exit.'
}

/** Runs one DSH agent that conducts the published installation contract. */
export async function runInstaller(sourceRoot: string, paths = defaultInstallerPaths()): Promise<void> {
  assertInteractiveTerminal()
  const dshHome = join(paths.stateDirectory, 'dsh')
  await assertInstallerAgentCredential(dshHome)
  const source = await validatedSourceRoot(sourceRoot)
  const home = process.env.HOME
  if (home === undefined || home === '') throw new Error('HOME is required to run the installer agent')
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  let requestExit!: () => void
  const exitRequested = new Promise<void>(resolve => { requestExit = resolve })
  let agent: DshAgentSession | undefined
  const tools = new Map<string, ReturnType<InstallerTui['beginTool']>>()
  const tui = new InstallerTui({
    onSubmit: async text => { await agent?.prompt(text) },
    onExit: requestExit,
  })
  const credentials = new CredentialFileAdapter({ home })
  const socketPath = join(paths.stateDirectory, `credential-${process.pid}-${randomUUID()}.sock`)
  const bridge = new CredentialBridge({ socketPath, tui, credentials })
  const credentialHelper = fileURLToPath(new URL('./credential-bin.mjs', import.meta.url))
  try {
    tui.start()
    tui.setProgress('Starting the installation assistant')
    await bridge.start()
    agent = new DshAgentSession({
      dshHome,
      workspace: source,
      environment: { MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: socketPath },
      onEvent: event => { renderAgentEvent(tui, tools, event) },
      onStatus: status => { tui.setProgress(status === 'running' ? 'Machtiani is working' : undefined) },
    })
    await agent.start()
    const contract = await readFile(join(source, 'INSTALL.md'), 'utf8')
    await agent.prompt(installerAgentPrompt(contract, credentialHelper))
    const code = await Promise.race([
      exitRequested.then(() => undefined),
      agent.whenExited().then(exitCode => exitCode),
    ])
    if (typeof code === 'number' || code === null) throw new Error(`The installation assistant exited unexpectedly (${code ?? 'unknown'}).`)
  } finally {
    await agent?.shutdown().catch(() => {})
    await tui.dispose()
    await bridge.close()
    await lock.release()
  }
}

export { acquireInstallerLock, InstallerAlreadyRunningError } from './lock.ts'
export { validatedSourceRoot }
