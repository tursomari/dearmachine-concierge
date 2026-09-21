import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialFileAdapter, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { MachtianiCredentialTarget } from '../src/credential-machtiani.ts'
import { machtianiConfigPath, migrateMachtianiConfig } from '../src/machtiani-config.ts'

// Explicitly select a prepared native distribution; all writes use disposable homes.
describe.runIf(process.platform === 'win32' && !!process.env.MACHTIANI_TEST_DISTRIBUTION)('Windows native configuration helpers', () => {
  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'Machtiani configuration Ω '))
    await protectPrivatePath(home, 0o700)
    const environment = { ...process.env, HOME: home, USERPROFILE: home,
      MACHTIANI_DISTRIBUTION: process.env.MACHTIANI_TEST_DISTRIBUTION }
    return { home, environment, adapter: new CredentialFileAdapter({ home }) }
  }

  it('changes a private provider reference through the actual Windows executable', async () => {
    const f = await fixture()
    try {
      await f.adapter.prepare('machtiani-provider', 'DeepSeek')
      await f.adapter.save('machtiani-provider', 'counterfeit-new-key')
      const config = machtianiConfigPath(f.home)
      await writeFile(config, 'default_model = "fixture"\n[providers.deepseek]\nbase_url = "https://example.invalid"\napi_key = "counterfeit-old-key"\n[models.fixture]\nprovider = "deepseek"\nmodel = "fixture"\n')
      await mkdir(join(f.home, '.machtiani'))
      const personal = join(f.home, '.machtiani/config.toml')
      await writeFile(personal, 'personal sentinel\n')
      await new MachtianiCredentialTarget(f.environment).configure('deepseek', f.adapter.reference('machtiani-provider')!)
      const actual = await readFile(config, 'utf8')
      expect(actual).toContain('api_key_ref = "DEEPSEEK_API_KEY"')
      expect(actual).not.toContain('counterfeit-old-key')
      expect(actual).toContain('default_model = "fixture"')
      expect(await readFile(personal, 'utf8')).toBe('personal sentinel\n')
      expect(await f.adapter.prepare('machtiani-provider', 'DeepSeek')).toBe('ready')
    } finally { await rm(f.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
  }, 90_000)

  it('imports a legacy configuration once without changing the personal source', async () => {
    const f = await fixture()
    try {
      await f.adapter.prepare('backend-provider', 'DeepSeek')
      await f.adapter.save('backend-provider', 'counterfeit-source-key')
      await mkdir(join(f.home, '.dearmachine/config'), { recursive: true })
      await writeFile(join(f.home, '.dearmachine/config/runtime.toml'), 'fixture\n')
      await mkdir(join(f.home, '.machtiani'))
      const source = join(f.home, '.machtiani/config.toml')
      const original = 'default_model = "fixture"\n[providers.fixture]\nbase_url = "https://example.invalid"\napi_key = "${DEEPSEEK_API_KEY}"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\n'
      await writeFile(source, original)
      await migrateMachtianiConfig(f.environment)
      expect(await readFile(machtianiConfigPath(f.home), 'utf8')).toContain('credentials_file = "credentials.env"')
      const credentials = join(f.home, '.config/dearmachine/machtiani/credentials.env')
      const imported = await readFile(credentials, 'utf8')
      expect(imported).toBe('DEEPSEEK_API_KEY=counterfeit-source-key\n')
      await f.adapter.save('backend-provider', 'counterfeit-later-key')
      await migrateMachtianiConfig(f.environment)
      expect(await readFile(credentials, 'utf8')).toBe(imported)
      expect(await readFile(source, 'utf8')).toBe(original)
    } finally { await rm(f.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
  }, 90_000)
})
