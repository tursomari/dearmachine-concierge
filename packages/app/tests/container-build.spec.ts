import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildContainerDistribution } from '../src/container-build.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(script: string, method: 'standard' | 'container' = 'container') {
  const root = await mkdtemp(join(tmpdir(), 'container build '))
  directories.push(root)
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'source'))
  await mkdir(join(root, 'bin'))
  for (const name of ['dearmachine', 'machtiani', 'agent-manager', 'machtiani-model-host']) {
    await writeFile(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  await writeFile(join(root, 'distribution.json'), JSON.stringify({ version: 1, method, sourceRoot: 'source', binaries: {
    dearmachine: 'bin/dearmachine', machtiani: 'bin/machtiani', agentManager: 'bin/agent-manager', modelHost: 'bin/machtiani-model-host',
  } }))
  await writeFile(join(root, 'scripts/standard-build.py'), script)
  return { sourceRoot: root, diagnosticPath: join(root, 'state/build.log'), signal: new AbortController().signal }
}

it('loads and verifies the builder receipt with source paths containing spaces', async () => {
  const options = await fixture('import json, pathlib\nprint(json.dumps({"manifest": str(pathlib.Path(__file__).resolve().parents[1] / "distribution.json")}))\n')
  const result = await buildContainerDistribution(options)
  expect(result.method).toBe('container')
  expect(result.sourceRoot).toBe(join(options.sourceRoot, 'source'))
})

it('retains build diagnostics without presenting raw subprocess output as a successful installation', async () => {
  const options = await fixture('import sys\nsys.stderr.write("fixture build error\\n")\nsys.exit(7)\n')
  await expect(buildContainerDistribution(options)).rejects.toThrow('Standard build failed')
  expect(await readFile(options.diagnosticPath, 'utf8')).toContain('fixture build error')
})

it('does not start a build after cancellation', async () => {
  const options = await fixture('raise RuntimeError("must not execute")\n')
  const controller = new AbortController()
  controller.abort()
  await expect(buildContainerDistribution({ ...options, signal: controller.signal })).rejects.toThrow()
  await expect(readFile(options.diagnosticPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancels a running builder and lets the wizard recover', async () => {
  const options = await fixture('import time\ntime.sleep(60)\n')
  const controller = new AbortController()
  const pending = buildContainerDistribution({ ...options, signal: controller.signal })
  const check = expect(pending).rejects.toThrow('cancelled')
  setTimeout(() => controller.abort(), 100)
  await check
})

it('accepts a native Standard distribution through the same builder handoff', async () => {
  const options = await fixture('import json, pathlib\nprint(json.dumps({"manifest": str(pathlib.Path(__file__).resolve().parents[1] / "distribution.json")}))\n', 'standard')
  const result = await buildContainerDistribution(options)
  expect(result.method).toBe('standard')
})
