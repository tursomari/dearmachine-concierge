import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentManagerBackendAdapter, loadPrivateEnvironment } from '../src/index.ts'

describe('backend adapter', () => {
  it('discovers only supported executable names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-discovery-'))
    for (const command of ['codex', 'omp']) {
      const path = join(root, command)
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o700)
    }
    const adapter = new AgentManagerBackendAdapter({ environment: { PATH: `${root}:${process.env.PATH ?? ''}` } })
    const result = await adapter.discover()
    expect(result.map(candidate => candidate.name)).toEqual(expect.arrayContaining(['Codex', 'OMP']))
    expect(result.map(candidate => candidate.name)).not.toContain('Unknown')
  })

  it('runs an isolated functional health probe for every permitted candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-check-'))
    const manager = join(root, 'agent-manager')
    await writeFile(manager, `#!/usr/bin/env bash
set -euo pipefail
test "$1 $2" = 'backend health'
test -n "$DEARMACHINE_BACKENDS"
printf 'backend=%s\\nresult=ok\\n' "$3"
`)
    await chmod(manager, 0o700)
    const adapter = new AgentManagerBackendAdapter({ managerCommand: [manager] })
    const candidates = [
      { name: 'Codex', id: 'codex-yolo', executable: '/test/codex' },
      { name: 'Forge', id: 'forge', executable: '/test/forge' },
    ]
    await expect(adapter.check(candidates)).resolves.toEqual([
      { ...candidates[0], status: 'ready', summary: 'functional probe passed' },
      { ...candidates[1], status: 'ready', summary: 'functional probe passed' },
    ])
  })

  it('loads private assignments without accepting loose file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-env-'))
    const path = join(root, 'backends.env')
    await writeFile(path, 'OPENROUTER_API_KEY=test-value\n', { mode: 0o600 })
    await expect(loadPrivateEnvironment(path)).resolves.toEqual({ OPENROUTER_API_KEY: 'test-value' })
    await chmod(path, 0o644)
    await expect(loadPrivateEnvironment(path)).rejects.toThrow('private regular file')
  })

  it('does not expose a provider credential to a backend unless its ID is explicitly compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-env-boundary-'))
    const manager = join(root, 'agent-manager')
    const providerEnvironmentPath = join(root, 'backends.env')
    await writeFile(providerEnvironmentPath, 'OPENROUTER_API_KEY=backend-test-secret\n', { mode: 0o600 })
    await writeFile(manager, `#!/usr/bin/env bash
set -euo pipefail
test -z "\${OPENROUTER_API_KEY:-}"
printf 'result=ok\n'
`)
    await chmod(manager, 0o700)
    const candidate = { name: 'Forge', id: 'forge', executable: '/test/forge' }
    const adapter = new AgentManagerBackendAdapter({ managerCommand: [manager], providerEnvironmentPath })
    await expect(adapter.check([candidate])).resolves.toEqual([
      { ...candidate, status: 'ready', summary: 'functional probe passed' },
    ])
  })
})
