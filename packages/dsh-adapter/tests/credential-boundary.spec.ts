import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialBoundary } from '../src/credential-boundary.ts'
import { apply } from '../src/credential-policy.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'credential-boundary-'))
  roots.push(home)
  const directory = join(home, '.config/dearmachine')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'backends.env')
  const key = 'fixture-provider-value-not-a-real-key'
  await writeFile(path, `CUSTOM_API_KEY=${key}\n`, { mode: 0o600 })
  const boundary = new CredentialBoundary({ home, environment: {} })
  await boundary.refresh()
  return { home, directory, path, key, boundary }
}

describe('credential tool boundary', () => {
  it('protects both new Machtiani credential stores while leaving configs readable', async () => {
    const { home, boundary } = await fixture()
    for (const scope of ['machtiani', 'dearmachine/machtiani']) {
      const dir = join(home, '.config', scope)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const key = scope.replace('/', '-') + '-private-fixture-key'
      await writeFile(join(dir, 'credentials.env'), `KEY=${key}\n`, { mode: 0o600 })
      await boundary.refresh()
      expect(await boundary.protectedPath(join(dir, 'credentials.env'), home)).toBe(true)
      expect(boundary.containsCredential({ stdout: key })).toBe(true)
      expect(await boundary.protectedPath(join(dir, 'config.toml'), home)).toBe(false)
    }
  })

  it('denies the original read and symlink aliases while permitting ordinary config', async () => {
    const { home, path, boundary } = await fixture()
    await symlink(path, join(home, 'innocent.txt'))
    expect(await boundary.protectedPath(path, home)).toBe(true)
    expect(await boundary.protectedPath('innocent.txt', home)).toBe(true)
    expect(await boundary.protectedPath('.config/dearmachine/../dearmachine/backends.env', home)).toBe(true)
    expect(await boundary.protectedPath('.dearmachine/config/dearmachine.toml', home)).toBe(false)
  })

  it('recognizes values anywhere in results including metadata, errors and encoded shell output', async () => {
    const { key, boundary } = await fixture()
    for (const value of [
      { content: [{ text: key }] }, { meta: { lines: [{ text: key }] } },
      { error: { message: key } }, { value: { stdout: { text: key } } },
      { additionalContexts: [{ content: key }] }, Buffer.from(key).toString('base64'),
      Buffer.from(key).toString('hex'), key.slice(0, 12) + '\n' + key.slice(12),
      Buffer.from(`CUSTOM_API_KEY=${key}\n`).toString('base64').replace(/(.{12})/gu, '$1\n'),
      Buffer.from(`X=${key}\n`).toString('base64'),
    ]) expect(boundary.containsCredential(value)).toBe(true)
    expect(boundary.containsCredential({ text: 'Backend configured.', variable: 'CUSTOM_API_KEY' })).toBe(false)
  })

  it('loads custom model references and credentials created during the session, retaining rotated values', async () => {
    const { home, path, key, boundary } = await fixture()
    const next = 'fixture-rotated-provider-value'
    await writeFile(path, `CUSTOM_API_KEY=${next}\n`, { mode: 0o600 })
    await boundary.refresh()
    expect(boundary.containsCredential(key)).toBe(true)
    expect(boundary.containsCredential(next)).toBe(true)
    const custom = join(home, 'model.env')
    await writeFile(custom, 'MODEL_KEY=fixture-custom-model-value\n', { mode: 0o600 })
    const profile = join(home, 'profile.json')
    await writeFile(profile, JSON.stringify({ credential: { kind: 'environment-file', path: custom, variable: 'MODEL_KEY' } }))
    const other = new CredentialBoundary({ home, profile, environment: {} })
    await other.refresh()
    expect(await other.protectedPath(custom, home)).toBe(true)
    expect(other.containsCredential('fixture-custom-model-value')).toBe(true)
  })

  it('fails closed for unreadable, unsafe, or malformed stores without including their contents', async () => {
    const { path, key, boundary } = await fixture()
    await chmod(path, 0o644)
    await expect(boundary.refresh()).rejects.toThrow('Credential protection is unavailable')
    await chmod(path, 0o600)
    await writeFile(path, key)
    await expect(boundary.refresh()).rejects.toThrow('Credential protection is unavailable')
  })

  it('blocks hidden metadata and checks model egress before invoking the transport', async () => {
    const { home, path, key } = await fixture()
    vi.stubEnv('HOME', home)
    vi.stubEnv('MACHTIANI_MODEL_PROFILE', '')
    const hooks = new Map<string, (...args: any[]) => any>()
    await apply({ on: (name: string, fn: (...args: any[]) => any) => hooks.set(name, fn) } as never)
    const post = hooks.get('tools/post-execute')!
    const accepted = async () => ({ kind: 'accept' })
    expect(await post({}, { content: [{ type: 'text', text: 'safe display' }], meta: { hidden: key } }, accepted)).toMatchObject({ kind: 'block' })
    expect(await post({}, { content: [{ type: 'text', text: 'safe display' }] }, accepted)).toEqual({ kind: 'accept' })
    const transport = vi.fn(async function* () { yield { type: 'finish' } })
    const stream = hooks.get('llm/stream')!
    await expect(stream({ messages: [{ content: key }] }, transport).next()).rejects.toThrow('Credential access or output was blocked')
    expect(transport).not.toHaveBeenCalled()
    await expect(stream({ messages: [{ content: 'ordinary status request' }] }, transport).next()).resolves.toMatchObject({ value: { type: 'finish' } })
    await chmod(path, 0o644)
    expect(await post({}, { content: [] }, accepted)).toMatchObject({ kind: 'block' })
    await expect(stream({ messages: [] }, transport).next()).rejects.toThrow('Credential protection is unavailable')
  })
})
