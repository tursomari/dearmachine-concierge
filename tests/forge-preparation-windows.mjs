// No provider requests. Verify the ordinary-user Windows credential handoff.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareForge21321 } from '../packages/backend-adapter/dist/index.mjs'
import { protectPrivatePath, hasPrivatePermissions } from '../packages/credential-adapter/dist/index.mjs'
assert.equal(process.platform, 'win32')
const root = await mkdtemp(join(tmpdir(), 'forge Windows Ω '))
const credentials = join(root, 'provider.env')
try {
  await protectPrivatePath(root, 0o700)
  await writeFile(credentials, 'OPENAI_API_KEY=windows-fixture-not-a-real-key\n', { flag: 'wx' })
  let imported = false
  const run = async (args, cwd, environment) => {
    const result = stdout => ({ code: 0, stdout, stderr: '' })
    if (args.includes('--version')) return result('forge 2.13.21\n')
    if (args.length === 1) {
      const compatibility = join(root, '.env')
      assert.equal((await lstat(compatibility)).isSymbolicLink(), false)
      assert.ok(await hasPrivatePermissions(compatibility))
      assert.equal(await readFile(compatibility, 'utf8'), await readFile(credentials, 'utf8'))
      assert.equal(environment.FORGE_CONFIG, join(root, '.forge'))
      await writeFile(join(root, '.forge', '.credentials.json'), '[]\n')
      imported = true
      return result('')
    }
    if (args.includes('--porcelain')) return result(args.includes('provider') ? 'openai\n' : 'fixture-model\n')
    if (args.includes('--prompt')) return result('READY\n')
    return result('')
  }
  await prepareForge21321({ home: root, provider: 'openai', model: 'fixture-model', providerEnvironmentPath: credentials, run })
  assert.ok(imported)
  await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' })
  await writeFile(join(root, '.env'), 'existing user configuration\n', { flag: 'wx' })
  await assert.rejects(prepareForge21321({ home: root, provider: 'openai', model: 'fixture-model', providerEnvironmentPath: credentials, run }), /refused to replace/)
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'existing user configuration\n')
  console.log('WINDOWS_FORGE_CREDENTIAL_HANDOFF_OK: private temporary file, cleanup, preservation of existing configuration')
} finally { await rm(root, { recursive: true, force: true }) }
