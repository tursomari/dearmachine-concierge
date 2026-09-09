import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadInterfacePreferences, saveInterfacePreferences } from '../src/interface-preferences.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'interface-preferences-')); roots.push(home)
  const directory = join(home, '.config', 'dearmachine')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return { home, directory, path: join(directory, 'interface.json') }
}
it('defaults to summary-only commands for existing installations', async () => {
  const { home } = await fixture()
  expect(await loadInterfacePreferences(home)).toEqual({ showCommands: false })
})
it.each([true, false])('persists the explicit %s choice across reopening without changing other config', async showCommands => {
  const { home, directory, path } = await fixture()
  await writeFile(join(directory, 'backends.env'), 'fixture unchanged', { mode: 0o600 })
  await saveInterfacePreferences(home, { showCommands: !showCommands })
  await saveInterfacePreferences(home, { showCommands })
  expect(await loadInterfacePreferences(home)).toEqual({ showCommands })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, showCommands })
  expect((await stat(path)).mode & 0o077).toBe(0)
  expect(await readFile(join(directory, 'backends.env'), 'utf8')).toBe('fixture unchanged')
})
it.each(['{', '{"version":2,"showCommands":true}', '{"version":1,"showCommands":"yes"}'])('ignores invalid preferences without preventing local controls: %s', async content => {
  const { home, path } = await fixture(); await writeFile(path, content, { mode: 0o600 })
  expect(await loadInterfacePreferences(home)).toEqual({ showCommands: false })
})
it('does not follow or overwrite a symbolic-link preference file', async () => {
  const { home, path } = await fixture()
  const target = join(home, 'unrelated.json')
  const original = '{"version":1,"showCommands":true}'
  await writeFile(target, original, { mode: 0o600 }); await symlink(target, path)
  expect(await loadInterfacePreferences(home)).toEqual({ showCommands: false })
  await expect(saveInterfacePreferences(home, { showCommands: false })).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe(original)
})
