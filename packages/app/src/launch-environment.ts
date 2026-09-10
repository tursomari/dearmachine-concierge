import { isAbsolute, join } from 'node:path'

/** Preserve caller precedence; make user-installed backends visible to all children.
 * No shell startup files, credential loading, or global environment edits.
 */
export function launchEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = environment.HOME
  const path = environment.PATH || '/usr/bin:/bin'
  if (!home || !isAbsolute(home) || home.includes(':')) return { ...environment, PATH: path }
  const localBin = join(home, '.local', 'bin')
  return { ...environment, PATH: path.split(':').includes(localBin) ? path : `${path}:${localBin}` }
}
