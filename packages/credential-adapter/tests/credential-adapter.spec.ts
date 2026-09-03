import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialFileAdapter, resolveCredentialReference } from '../src/index.ts'

describe('credential file adapter', () => {
  it('maps supported selections to private references without values', () => {
    expect(resolveCredentialReference('llm', 'OpenRouter', '/home/test')).toEqual({
      kind: 'llm', destination: '/home/test/.config/dearmachine/backends.env',
      format: 'environment', variable: 'OPENROUTER_API_KEY',
    })
    expect(resolveCredentialReference('email', 'Sendmux', '/home/test').destination).toBe('/home/test/.config/dearmachine/sendmux-api-key')
  })

  it('atomically saves environment and raw credentials with private permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-adapter-'))
    const adapter = new CredentialFileAdapter({ home })
    await expect(adapter.prepare('llm', 'OpenRouter')).resolves.toBe('pending')
    await adapter.save('llm', 'provider-test-value')
    const providerPath = join(home, '.config/dearmachine/backends.env')
    expect(await readFile(providerPath, 'utf8')).toBe('OPENROUTER_API_KEY=provider-test-value\n')
    expect((await lstat(providerPath)).mode & 0o777).toBe(0o600)

    await expect(adapter.prepare('email', 'AgentMail')).resolves.toBe('pending')
    await adapter.save('email', 'transport-test-value')
    const transportPath = join(home, '.config/dearmachine/agentmail-api-key')
    expect(await readFile(transportPath, 'utf8')).toBe('transport-test-value\n')
    expect((await lstat(transportPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(join(home, '.config/dearmachine'))).filter(name => name.startsWith('.machtiani-credential-'))).toEqual([])

    const restarted = new CredentialFileAdapter({ home })
    await expect(restarted.prepare('llm', 'OpenRouter')).resolves.toBe('ready')
    await expect(restarted.prepare('email', 'AgentMail')).resolves.toBe('ready')
  })

  it('replaces a credential when the selected provider changes without retaining the old value', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-switch-'))
    const destination = join(home, '.config', 'dearmachine', 'backends.env')
    await mkdir(join(home, '.config', 'dearmachine'), { recursive: true, mode: 0o700 })
    await writeFile(destination, 'OPENROUTER_API_KEY=previous-provider-value\n', { mode: 0o600 })
    const adapter = new CredentialFileAdapter({ home })
    await expect(adapter.prepare('llm', 'DeepSeek')).resolves.toBe('pending')
    await adapter.save('llm', 'replacement-provider-value')
    const stored = await readFile(destination, 'utf8')
    expect(stored).toBe('DEEPSEEK_API_KEY=replacement-provider-value\n')
    expect(stored).not.toContain('previous-provider-value')
  })

  it('rejects multiline and whitespace-bearing input without creating a file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-invalid-'))
    const adapter = new CredentialFileAdapter({ home })
    await adapter.prepare('email', 'AgentMail')
    await expect(adapter.save('email', 'not a valid key')).rejects.toThrow('one nonempty line')
    await expect(readFile(join(home, '.config/dearmachine/agentmail-api-key'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the credential destination is a symbolic link', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-symlink-'))
    const directory = join(home, '.config', 'dearmachine')
    const outside = join(home, 'outside')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(outside, 'outside-value\n', { mode: 0o600 })
    await symlink(outside, join(directory, 'agentmail-api-key'))
    const adapter = new CredentialFileAdapter({ home })
    await expect(adapter.prepare('email', 'AgentMail')).rejects.toThrow('private regular file')
    expect(await readFile(outside, 'utf8')).toBe('outside-value\n')
  })

  it('tightens an existing credential directory before writing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-mode-'))
    const directory = join(home, '.config', 'dearmachine')
    await mkdir(directory, { recursive: true, mode: 0o755 })
    await chmod(directory, 0o755)
    const adapter = new CredentialFileAdapter({ home })
    await adapter.prepare('email', 'AgentMail')
    await adapter.save('email', 'private-value')
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
  })
})
