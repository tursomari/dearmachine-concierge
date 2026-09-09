import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface InterfacePreferences { showCommands: boolean }
const defaults: InterfacePreferences = { showCommands: false }
const directoryFor = (home: string) => join(home, '.config', 'dearmachine')
const owned = (uid: number) => process.getuid === undefined || uid === process.getuid()

/** Optional presentation state must never prevent provider-free local controls. */
export async function loadInterfacePreferences(home: string): Promise<InterfacePreferences> {
  try {
    const directory = directoryFor(home)
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent.uid)) return { ...defaults }
    const file = await open(join(directory, 'interface.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || !owned(metadata.uid) || metadata.size > 4096 || (metadata.mode & 0o077) !== 0) return { ...defaults }
      const value = JSON.parse(await file.readFile('utf8')) as Record<string, unknown> | null
      return value?.version === 1 && typeof value.showCommands === 'boolean'
        ? { showCommands: value.showCommands } : { ...defaults }
    } finally { await file.close() }
  } catch { return { ...defaults } }
}

export async function saveInterfacePreferences(home: string, preferences: InterfacePreferences): Promise<void> {
  const directory = directoryFor(home)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent.uid)) throw new Error('Invalid interface preference directory')
  const path = join(directory, 'interface.json')
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || !owned(metadata.uid)) throw new Error('Invalid interface preference file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = await mkdtemp(join(directory, '.interface-'))
  try {
    const staged = join(temporary, 'interface.json')
    await writeFile(staged, `${JSON.stringify({ version: 1, showCommands: preferences.showCommands })}\n`, { mode: 0o600 })
    await rename(staged, path)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
