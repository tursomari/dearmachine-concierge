import { isAbsolute, join, win32 } from 'node:path'

/** Preserve caller precedence; make user-installed backends visible to all children.
 * No shell startup files, credential loading, or global environment edits.
 */
export function launchEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    const result = { ...environment }
    const value = (name: string) => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
    const entries = (value('PATH') ?? '').split(';').filter(Boolean)
    const home = value('USERPROFILE') || value('HOME')
    const local = value('LOCALAPPDATA')
    const candidates = [
      home && win32.isAbsolute(home) ? win32.join(home, '.local', 'bin') : undefined,
      local && win32.isAbsolute(local) ? win32.join(local, 'omp') : undefined,
    ]
    for (const path of candidates) {
      if (path && !entries.some(entry => entry.toLowerCase() === path.toLowerCase())) entries.push(path)
    }
    // Node sorts environment keys on Windows; duplicate Path/PATH keys can
    // silently discard the value passed to a child. Emit one canonical key.
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key]
    return { ...result, PATH: entries.join(';') }
  }
  const home = environment.HOME
  const path = environment.PATH || '/usr/bin:/bin'
  if (!home || !isAbsolute(home) || home.includes(':')) return { ...environment, PATH: path }
  const localBin = join(home, '.local', 'bin')
  return { ...environment, PATH: path.split(':').includes(localBin) ? path : `${path}:${localBin}` }
}
