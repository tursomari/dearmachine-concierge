import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { InstallerTui, assertInteractiveTerminal } from '@dearmachine/machtiani-installer-tui'
import { runCompleteInstallation, runFirstThreeStages, type CheckpointPort, type WorkflowCheckpoint } from '@dearmachine/machtiani-installer-workflow'
import { CredentialFileAdapter } from '@dearmachine/machtiani-installer-credentials'
import { AgentManagerBackendAdapter } from '@dearmachine/machtiani-installer-backends'
import { LocalEnvironmentAdapter } from '@dearmachine/machtiani-installer-environment'
import { NativeProductInstaller } from '@dearmachine/machtiani-installer-products'
import { acquireInstallerLock } from './lock.ts'

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
  const tui = new InstallerTui()
  const checkpointPath = join(paths.stateDirectory, 'preview-checkpoint.json')
  try {
    tui.start()
    const result = await runFirstThreeStages({
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
    if (result !== undefined) tui.addAssistant('The no-change installation preview is complete. No products or credentials were installed.')
  } finally {
    await tui.dispose()
    await lock.release()
  }
}

/** Runs the complete guided native installation and live email verification. */
export async function runInstaller(sourceRoot: string, paths = defaultInstallerPaths()): Promise<void> {
  assertInteractiveTerminal()
  const source = await validatedSourceRoot(sourceRoot)
  const home = process.env.HOME
  if (home === undefined || home === '') throw new Error('HOME is required to prepare private credential references')
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  const tui = new InstallerTui()
  const backends = new AgentManagerBackendAdapter({
    providerEnvironmentPath: join(home, '.config', 'dearmachine', 'backends.env'),
    managerCommand: ['nix', 'shell', `path:${join(source, 'dearmachine')}#agent-manager`, '--command', 'agent-manager'],
  })
  const products = new NativeProductInstaller({
    home,
    sourceRoot: source,
    workspace: paths.workspace,
    journalPath: join(paths.stateDirectory, 'product-installation.json'),
    diagnosticPath: join(paths.stateDirectory, 'product-command-diagnostic.json'),
    progress: message => tui.setProgress(message),
  })
  try {
    tui.start()
    await runCompleteInstallation({
      conversation: conversation(tui),
      environment: new LocalEnvironmentAdapter({ backends }),
      credentials: new CredentialFileAdapter({ home }),
      backends,
      products,
      checkpoint: checkpointStore(join(paths.stateDirectory, 'installation-checkpoint.json')),
    })
  } finally {
    await tui.dispose()
    await lock.release()
  }
}

export { acquireInstallerLock, InstallerAlreadyRunningError } from './lock.ts'
export { validatedSourceRoot }
