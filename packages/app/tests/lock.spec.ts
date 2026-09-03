import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireInstallerLock, InstallerAlreadyRunningError } from '../src/index.ts'

describe('installer process lock', () => {
  it('rejects a duplicate invocation and identifies the owning process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machtiani-lock-test-'))
    const path = join(directory, 'installer.lock')
    const first = await acquireInstallerLock(path)
    await expect(acquireInstallerLock(path)).rejects.toEqual(expect.objectContaining({
      name: InstallerAlreadyRunningError.name,
      ownerPid: process.pid,
    }))
    await first.release()
  })

  it('recovers an abandoned lock and only removes its own token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machtiani-lock-test-'))
    const path = join(directory, 'installer.lock')
    await writeFile(path, '{"pid":2147483647,"token":"gone"}\n')
    const lock = await acquireInstallerLock(path)
    const replacement = '{"pid":2147483647,"token":"replacement"}\n'
    await writeFile(path, replacement)
    await lock.release()
    expect(await readFile(path, 'utf8')).toBe(replacement)
  })
})
