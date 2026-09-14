import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MachtianiCredentialTarget } from '../src/credential-machtiani.ts'

describe('Machtiani credential target', () => {
  async function fixture(script: string) {
    const home = await mkdtemp(join(tmpdir(), 'cm-'))
    await mkdir(join(home, '.local/bin'), { recursive: true })
    await writeFile(join(home, '.local/bin/machtiani'), `#!/bin/sh\n${script}\n`, { mode: 0o700 })
    return { home, target: new MachtianiCredentialTarget({ HOME: home, PATH: process.env.PATH }) }
  }

  it('uses the installed native writer with a reference and suppresses automatic updates', async () => {
    const f = await fixture(`test "$MACHTIANI_UPDATE_REEXEC" = 1 || exit 1
test "$MACHTIANI_CONFIG" = "$HOME/.config/dearmachine/machtiani/config.toml" || exit 1
if [ "$3" = show ]; then printf 'Provider deepseek\\n'; else printf '%s\\n' "$@" > "$HOME/arguments"; fi`)
    try {
      await f.target.configure('deepseek', { kind: 'machtiani-provider', destination: join(f.home, '.config/dearmachine/machtiani/credentials.env'), format: 'environment', variable: 'DEEPSEEK_API_KEY' })
      expect((await readFile(join(f.home, 'arguments'), 'utf8')).trim().split('\n')).toEqual([
        'config', 'provider', 'set', 'deepseek', '--api-key-env', 'DEEPSEEK_API_KEY', '--credentials-file', join(f.home, '.config/dearmachine/machtiani/credentials.env'), '--no-interactive',
      ])
    } finally { await rm(f.home, { recursive: true, force: true }) }
  })

  it('rejects model-host providers before writing', async () => {
    const f = await fixture("printf 'Provider shared\\n  transport: model-host\\n'")
    try { await expect(f.target.check('shared')).rejects.toThrow('model-host profile') }
    finally { await rm(f.home, { recursive: true, force: true }) }
  })

  it('does not relay private native errors to the model', async () => {
    const f = await fixture("printf 'private-fixture-key' >&2; exit 1")
    try {
      await expect(f.target.check('deepseek')).rejects.toThrow('Machtiani provider configuration failed')
      await expect(f.target.check('--path')).rejects.toThrow('exact Machtiani provider alias')
    } finally { await rm(f.home, { recursive: true, force: true }) }
  })
})


it.skipIf(!process.env.MACHTIANI_TEST_BINARY)('connects an actual Machtiani provider without changing model choices or other credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cm-native-'))
  try {
    await mkdir(join(home, '.local/bin'), { recursive: true })
    await mkdir(join(home, '.config/dearmachine/machtiani'), { recursive: true })
    await mkdir(join(home, '.config/machtiani'), { recursive: true })
    const personal = join(home, '.config/machtiani/config.toml')
    await writeFile(personal, 'personal sentinel\n')
    await symlink(process.env.MACHTIANI_TEST_BINARY!, join(home, '.local/bin/machtiani'))
    const path = join(home, '.config/dearmachine/machtiani/config.toml')
    await writeFile(path, `default_model = "deepseek"
shell_agent_model = "deepseek"
[providers.deepseek]
base_url = "https://example.test"
api_key = "stale-fixture-key"
[providers.other]
base_url = "https://other.example.test"
api_key = "preserved-fixture-key"
[models.deepseek]
provider = "deepseek"
model = "fixture-model"
`, { mode: 0o600 })
    const target = new MachtianiCredentialTarget({ HOME: home, PATH: process.env.PATH })
    await target.configure('deepseek', { kind: 'machtiani-provider', format: 'environment', variable: 'DEEPSEEK_API_KEY', destination: join(home, '.config/dearmachine/machtiani/credentials.env') })
    const config = await readFile(path, 'utf8')
    expect(config).not.toContain('stale-fixture-key')
    expect(config).toContain('api_key_ref = "DEEPSEEK_API_KEY"')
    expect(config).not.toContain('preserved-fixture-key')
    expect(await readFile(join(home, '.config/dearmachine/machtiani/credentials.env'), 'utf8')).toContain('preserved-fixture-key')
    expect(await readFile(personal, 'utf8')).toBe('personal sentinel\n')
    expect(config).toContain('default_model = "deepseek"')
    expect(config).toContain('shell_agent_model = "deepseek"')
    expect(config).toContain('model = "fixture-model"')
  } finally { await rm(home, { recursive: true, force: true }) }
})
