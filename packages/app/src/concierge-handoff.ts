import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'

/** Drop bootstrap release identity; the installed launcher supplies its own. */
export function installedConciergeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const name of ['DEARMACHINE_NATIVE_BIN', 'DEARMACHINE_CONCIERGE_BIN', 'DEARMACHINE_SOURCE_ROOT', 'MACHTIANI_DISTRIBUTION']) delete result[name]
  return result
}

/** Run only after installer/TUI cleanup, before constructing management controls. */
export async function handoffInstalledConcierge(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // A native launch already established the runtime. Never bounce it back into itself.
  if (environment.DEARMACHINE_NATIVE_BIN) return false
  const home = environment.HOME
  if (!home || !isAbsolute(home)) throw new Error('An absolute HOME is required to open the installed concierge.')
  const launcher = process.platform === 'win32'
    ? environment.DEARMACHINE_LAUNCHER
    : join(home, '.local', 'bin', 'dearmachine')
  if (!launcher) return false
  if (!(process.platform === 'win32' ? win32.isAbsolute(launcher) : isAbsolute(launcher))) throw new Error('The installed launcher must be an absolute path.')
  try { await access(launcher, constants.X_OK) }
  catch (error) {
    // Recovery remains available for older/partial installations without a public launcher.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const env = installedConciergeEnvironment(environment)
  if (process.platform !== 'win32') {
    if (!process.execve) throw new Error('Opening the installed concierge requires Node.js 22.15 or newer. Run ' + launcher + ' directly.')
    // Preserve the terminal and exit status, without leaving a bootstrap parent
    // or a second interface to receive terminal signals.
    process.execve(launcher, [launcher], env)
  }
  // Windows has no execve. Keep the terminal attached until its native launcher exits.
  const keepParent = () => {}
  process.on('SIGINT', keepParent)
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(launcher, [], { env, stdio: 'inherit', windowsHide: true })
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
  } finally { process.off('SIGINT', keepParent) }
  return true
}
