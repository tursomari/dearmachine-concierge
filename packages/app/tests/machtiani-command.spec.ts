import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installedMachtianiCommand } from '../src/machtiani-command.ts'
import { protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'

it('selects the validated Windows release instead of a Unix launcher or PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-command-'))
  try {
    await protectPrivatePath(root, 0o700)
    await mkdir(join(root, 'source'))
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin', 'writer.exe'), 'counterfeit executable', { mode: 0o700 })
    const binaries = Object.fromEntries(['dearmachine', 'machtiani', 'modelHost', 'agentManager'].map(name => [name, 'bin/writer.exe']))
    const manifest = join(root, 'distribution.json')
    await writeFile(manifest, JSON.stringify({ version: 1, sourceRoot: 'source', binaries }), { mode: 0o600 })
    expect(await installedMachtianiCommand(root, { MACHTIANI_DISTRIBUTION: manifest, PATH: '/unrelated' }, 'win32')).toBe(join(root, 'bin', 'writer.exe'))
    await expect(installedMachtianiCommand(root, { PATH: '/unrelated' }, 'win32')).rejects.toThrow('installed Windows launcher')
    await writeFile(manifest, JSON.stringify({ version: 1, sourceRoot: 'source', binaries: { ...binaries, machtiani: '../outside.exe' } }))
    await expect(installedMachtianiCommand(root, { MACHTIANI_DISTRIBUTION: manifest }, 'win32')).rejects.toThrow('relative to the release')
    expect(await installedMachtianiCommand(root, { MACHTIANI_DISTRIBUTION: manifest }, 'linux')).toBe(join(root, '.local', 'bin', 'machtiani'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
