// Native credential-store recovery; counterfeit credentials and no provider calls.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'win32') throw new Error('Run this fixture with native Windows Node')
const runtime = process.argv[2]
if (!runtime) throw new Error('Pass the relocated installer runtime')
const { CredentialFileAdapter, hasPrivatePermissions } = await import(pathToFileURL(join(runtime, 'packages/credential-adapter/dist/index.mjs')))
const { writeApiKeyCredential, readApiKeyCredential, removeApiKeyCredential } = await import(pathToFileURL(join(runtime, 'packages/model-host/dist/index.mjs')))
const home = await mkdtemp(join(tmpdir(), 'model-credential-recovery-'))
try {
  const adapter = new CredentialFileAdapter({ home })
  await adapter.prepare('backend-provider', 'Regional Gateway')
  await adapter.save('backend-provider', 'counterfeit-backend-key')
  const reference = adapter.reference('backend-provider')
  const original = await readFile(reference.destination, 'utf8')
  for (const value of ['counterfeit-assistant-key', 'counterfeit-replacement-key']) {
    await writeApiKeyCredential(reference.destination, 'custom-openai-remote', value)
    assert.equal(await readApiKeyCredential(reference.destination, 'custom-openai-remote'), value)
    assert.ok((await readFile(reference.destination, 'utf8')).includes(original.trim()))
    assert.equal(await hasPrivatePermissions(reference.destination), true)
  }
  await removeApiKeyCredential(reference.destination, 'custom-openai-remote')
  assert.equal(await readApiKeyCredential(reference.destination, 'custom-openai-remote'), undefined)
  assert.equal(await readFile(reference.destination, 'utf8'), original)
  assert.equal(await adapter.prepare('backend-provider', 'Regional Gateway'), 'ready')

  const unsupported = original + 'NODE_OPTIONS=--inspect\n'
  await writeFile(reference.destination, unsupported)
  await assert.rejects(writeApiKeyCredential(reference.destination, 'openrouter', 'counterfeit-key'), /unsupported assignments/u)
  assert.equal(await readFile(reference.destination, 'utf8'), unsupported)
  await assert.rejects(removeApiKeyCredential(reference.destination, 'openrouter'), /unsupported assignments/u)
  assert.equal(await readFile(reference.destination, 'utf8'), unsupported)
  console.log('WINDOWS_MODEL_CREDENTIAL_RECOVERY_OK')
} finally {
  await rm(home, { recursive: true, force: true })
}
