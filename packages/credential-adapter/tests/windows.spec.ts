import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialFileAdapter, hasPrivatePermissions } from '../src/index.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe.runIf(process.platform === 'win32')('Windows credential permissions', () => {
  it('reproduces a copied OMP file with chmod and refuses it until a private store is created', async () => {
    const home = await mkdtemp(join(tmpdir(), 'OMP ACL Ω ')); roots.push(home)
    const adapter = new CredentialFileAdapter({ home })
    await adapter.prepare('backend-provider', 'DeepInfra')
    await adapter.save('backend-provider', 'fixture-key-not-a-real-credential')
    const directory = join(home, '.omp', 'agent')
    const target = join(directory, '.env')
    await mkdir(directory, { recursive: true })
    await copyFile(adapter.reference('backend-provider')!.destination, target)
    await chmod(target, 0o600)
    expect(await hasPrivatePermissions(target)).toBe(false)
    await expect(adapter.configureOmp()).rejects.toThrow('private regular file')
    await rm(target)
    await adapter.configureOmp()
    expect(await hasPrivatePermissions(target)).toBe(true)
    const before = await readFile(target, 'utf8')
    await promisify(execFile)('icacls.exe', [target, '/grant', '*S-1-1-0:R'])
    await expect(adapter.configureOmp()).rejects.toThrow('private regular file')
    expect(await readFile(target, 'utf8')).toBe(before)
  }, 60_000)

  it('stores credentials privately in a home path containing spaces and Unicode and rejects broader access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'Dear Machine Ω ')); roots.push(home)
    const adapter = new CredentialFileAdapter({ home })
    await adapter.prepare('backend-provider', 'DeepInfra')
    await adapter.save('backend-provider', 'fixture-key-not-a-real-credential')
    const path = adapter.reference('backend-provider')!.destination
    expect(await hasPrivatePermissions(path)).toBe(true)
    expect(await adapter.prepare('backend-provider', 'DeepInfra')).toBe('ready')
    await promisify(execFile)('icacls.exe', [path, '/grant', '*S-1-1-0:R'])
    expect(await hasPrivatePermissions(path)).toBe(false)
    await expect(adapter.prepare('backend-provider', 'DeepInfra')).rejects.toThrow('private regular file')
  }, 30_000)
})
