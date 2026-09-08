import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadDistribution } from '../src/distribution.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-distribution-'))
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'source'))
  for (const name of ['dearmachine', 'machtiani', 'machtiani-model-host', 'agent-manager']) {
    await writeFile(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const manifest = { version: 1, sourceRoot: 'source', binaries: {
    dearmachine: 'bin/dearmachine', machtiani: 'bin/machtiani',
    modelHost: 'bin/machtiani-model-host', agentManager: 'bin/agent-manager',
  } }
  const path = join(root, 'distribution.json')
  await writeFile(path, JSON.stringify(manifest))
  return { root, path, manifest }
}

it('keeps existing Nix entrypoints unchanged without a distribution', async () => {
  expect(await loadDistribution({})).toBeUndefined()
})

it('resolves all prebuilt products relative to the installed release', async () => {
  const test = await fixture()
  expect(await loadDistribution({ MACHTIANI_DISTRIBUTION: test.path })).toMatchObject({
    sourceRoot: join(test.root, 'source'), binaries: { modelHost: join(test.root, 'bin/machtiani-model-host') },
  })
})

it.each(['../outside', '/bin/sh'])('rejects escaping product paths: %s', async path => {
  const test = await fixture()
  test.manifest.binaries.dearmachine = path
  await writeFile(test.path, JSON.stringify(test.manifest))
  await expect(loadDistribution({ MACHTIANI_DISTRIBUTION: test.path })).rejects.toThrow('relative')
})

it('rejects symlinks escaping the release and nonexecutable products', async () => {
  const test = await fixture()
  await symlink('/bin/sh', join(test.root, 'outside'))
  test.manifest.binaries.dearmachine = 'outside'
  await writeFile(test.path, JSON.stringify(test.manifest))
  await expect(loadDistribution({ MACHTIANI_DISTRIBUTION: test.path })).rejects.toThrow('release')
  test.manifest.binaries.dearmachine = 'bin/dearmachine'
  await writeFile(test.path, JSON.stringify(test.manifest))
  await chmod(join(test.root, 'bin/dearmachine'), 0o644)
  await expect(loadDistribution({ MACHTIANI_DISTRIBUTION: test.path })).rejects.toThrow('executable')
})
