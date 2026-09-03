import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InstallerTui, assertInteractiveTerminal } from '@dearmachine/machtiani-installer-tui'
import { runFirstThreeStages, type WorkflowCheckpoint } from '@dearmachine/machtiani-installer-workflow'
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

export async function runMockInstaller(paths = defaultInstallerPaths()): Promise<void> {
  assertInteractiveTerminal()
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  const lock = await acquireInstallerLock(join(paths.stateDirectory, 'installer.lock'))
  const tui = new InstallerTui()
  const checkpointPath = join(paths.stateDirectory, 'checkpoint.json')
  try {
    tui.start()
    const result = await runFirstThreeStages({
      conversation: {
        ask: message => tui.ask({ message }),
        progress: message => tui.setProgress(message),
        tool: (name, detail) => tui.beginTool(name, detail),
      },
      environment: {
        inspect: async () => ({ missingFoundations: [], detectedBackends: [] }),
        installFoundations: async () => { throw new Error('the no-mutation preview cannot install dependencies') },
      },
      credentials: {
        prepare: async () => {},
        status: async () => 'ready',
      },
      checkpoint: {
        load: async () => {
          try { return JSON.parse(await readFile(checkpointPath, 'utf8')) as WorkflowCheckpoint } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          }
        },
        save: async checkpoint => {
          await mkdir(dirname(checkpointPath), { recursive: true, mode: 0o700 })
          const temporary = `${checkpointPath}.${process.pid}.tmp`
          await writeFile(temporary, `${JSON.stringify(checkpoint, undefined, 2)}\n`, { mode: 0o600 })
          await rename(temporary, checkpointPath)
        },
      },
    })
    if (result !== undefined) tui.addAssistant('The no-change installation preview is complete. No products or credentials were installed.')
  } finally {
    await tui.dispose()
    await lock.release()
  }
}

export { acquireInstallerLock, InstallerAlreadyRunningError } from './lock.ts'
