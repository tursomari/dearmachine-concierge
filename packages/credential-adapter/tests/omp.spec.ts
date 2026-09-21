import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialFileAdapter, hasPrivatePermissions, protectPrivatePath } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'OMP credentials Ω ')); roots.push(home)
  const adapter = new CredentialFileAdapter({ home })
  await adapter.prepare('backend-provider', 'OpenAI')
  await adapter.save('backend-provider', 'unselected-fixture-key')
  await adapter.prepare('backend-provider', 'DeepInfra')
  await adapter.save('backend-provider', 'selected-fixture-key')
  return { home, adapter, target: join(home, '.omp', 'agent', '.env') }
}

describe('OMP private credential integration', () => {
  it('copies only the selected provider, verifies native privacy, preserves entries, and updates a rotated key', async () => {
    const { adapter, target } = await fixture()
    const reference = await adapter.configureOmp()
    expect(reference.destination).toBe(target)
    expect(JSON.stringify(reference)).not.toContain('fixture-key')
    expect(await readFile(target, 'utf8')).toBe(`${reference.variable}=selected-fixture-key\n`)
    expect(await hasPrivatePermissions(target)).toBe(true)
    await writeFile(target, (await readFile(target, 'utf8')) + 'UNRELATED_API_KEY=preserved-fixture-key\n')
    await adapter.save('backend-provider', 'rotated-fixture-key')
    await adapter.configureOmp()
    expect(await readFile(target, 'utf8')).toBe(`${reference.variable}=rotated-fixture-key\nUNRELATED_API_KEY=preserved-fixture-key\n`)
    expect(await hasPrivatePermissions(target)).toBe(true)
  }, 60_000)

  it('preserves unsupported existing dotenv content on failure', async () => {
    const { adapter, target, home } = await fixture()
    await mkdir(join(home, '.omp', 'agent'), { recursive: true })
    const content = '# human configuration\nOTHER="keep me"\n'
    await writeFile(target, content, { mode: 0o600 })
    await protectPrivatePath(target, 0o600)
    await expect(adapter.configureOmp()).rejects.toThrow('invalid assignment')
    expect(await readFile(target, 'utf8')).toBe(content)
  }, 60_000)

  it.skipIf(process.platform === 'win32')('refuses non-private or symlink destinations without changing them', async () => {
    const { adapter, target, home } = await fixture()
    await mkdir(join(home, '.omp', 'agent'), { recursive: true })
    await writeFile(target, 'OTHER=preserved\n', { mode: 0o600 })
    await chmod(target, 0o644)
    await expect(adapter.configureOmp()).rejects.toThrow('private regular file')
    expect(await readFile(target, 'utf8')).toBe('OTHER=preserved\n')
    await rm(target)
    const outside = join(home, 'outside.env')
    await writeFile(outside, 'OTHER=preserved\n', { mode: 0o600 })
    await symlink(outside, target)
    await expect(adapter.configureOmp()).rejects.toThrow('private regular file')
    expect(await readFile(outside, 'utf8')).toBe('OTHER=preserved\n')
  })
})
