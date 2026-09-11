import { lstat, mkdtemp, readlink, realpath, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ManagedRun } from './managed-nix.ts'

const publicCommands = new Set(['dearmachine', 'agent-manager', 'machtiani', 'machtiani-installer', 'machtiani-model-host'])
const storePath = /^\/nix\/store\/[a-z0-9]{32}-[^\s/]+$/u
interface Profile { version: number; elements: Record<string, { active: boolean; storePaths: string[] }> }
export interface ProfileMigration { entry: string; commands: string[]; profile: string; previous: string; generation: number; backup?: string }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}
async function profileLocation(home: string): Promise<{ profile: string; generation: number }> {
  let path = join(home, '.nix-profile')
  for (let depth = 0; depth < 16; depth++) {
    const info = await lstat(path)
    if (!info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('The Nix profile must be a symlink owned by the current user')
    const target = resolve(dirname(path), await readlink(path))
    const generation = /^(.*)-(\d+)-link$/u.exec(basename(target))
    if (generation && dirname(target) === dirname(path) && generation[1] === basename(path)) return { profile: path, generation: Number(generation[2]) }
    path = target
  }
  throw new Error('Cannot resolve the owned Nix profile generation')
}
export async function migrateProfile(options: { home: string; root: string; entry: string; check: boolean; run: ManagedRun }): Promise<ProfileMigration> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(options.entry)) throw new Error('Specify one exact Nix profile entry name; patterns and flags are not accepted')
  const { profile, generation } = await profileLocation(options.home)
  const previous = await realpath(profile)
  if (!storePath.test(previous)) throw new Error('The Nix profile does not resolve to a store path')
  const inspect = async () => JSON.parse(await options.run('nix', ['profile', 'list', '--profile', profile, '--json'])) as Profile
  const before = await inspect()
  if (before.version !== 3 || !before.elements || Array.isArray(before.elements)) throw new Error('This migration requires a named Nix profile (manifest version 3)')
  const selected = before.elements[options.entry]
  if (!selected?.active || !Array.isArray(selected.storePaths) || !selected.storePaths.length) throw new Error('The selected active Nix profile entry was not found')
  const provided = new Set<string>()
  for (const path of selected.storePaths) {
    if (!storePath.test(path)) throw new Error('Invalid profile package path')
    const names = await readdir(join(path, 'bin')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names) {
      if (publicCommands.has(name)) provided.add(name)
      else if (!(name.startsWith('.') && name.endsWith('-wrapped') && publicCommands.has(name.slice(1, -8)))) throw new Error('This profile entry also provides other commands; it must be migrated manually')
    }
  }
  if (!provided.size) throw new Error('The selected entry does not provide a coordinated product command')
  for (const command of provided) {
    const candidates = await Promise.all(selected.storePaths.map(path => realpath(join(path, 'bin', command)).catch(() => '')))
    if (!candidates.includes(await realpath(join(profile, 'bin', command)))) throw new Error('Another profile entry owns this command; inspect the profile before migrating')
  }
  const result: ProfileMigration = { entry: options.entry, commands: [...provided].sort(), profile, previous, generation }
  if (options.check) return result
  const backup = await mkdtemp(join(options.root, 'profile-migration-'))
  const record = { version: 1, ...result, manifest: before, status: 'prepared' }
  const save = async () => writeFile(join(backup, 'migration.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  await save()
  await options.run('nix-store', ['--add-root', join(backup, 'previous-profile'), '--indirect', '--realise', previous])
  if (await realpath(profile) !== previous || canonical(await inspect()) !== canonical(before)) throw new Error(`The profile changed during preparation; nothing was removed. Backup: ${backup}`)
  try {
    await options.run('nix', ['profile', 'remove', '--profile', profile, options.entry])
    const after = await inspect()
    const expected = { ...before.elements }; delete expected[options.entry]
    if (canonical(after.elements) !== canonical(expected)) throw new Error('The profile changed unexpectedly; inspect the retained backup before recovery')
    record.status = 'complete'; await save()
  } catch (error) { throw new Error(`Profile migration was not confirmed. Backup: ${backup}. ${error instanceof Error ? error.message : String(error)}`) }
  return { ...result, backup }
}
