import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalEnvironmentAdapter } from '../src/index.ts'

describe('environment adapter', () => {
  it('reports missing foundations and performs backend detection without probing', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'machtiani-environment-'))
    for (const command of ['nix', 'git', 'codex']) {
      const path = join(bin, command)
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o700)
    }
    let discoveries = 0
    const adapter = new LocalEnvironmentAdapter({
      environment: { PATH: bin },
      backends: {
        discover: async () => { discoveries += 1; return [{ name: 'Codex', id: 'codex-yolo', executable: join(bin, 'codex') }] },
      },
    })
    await expect(adapter.inspect()).resolves.toEqual({ missingFoundations: ['Git LFS', 'Micro'], detectedBackends: ['Codex'] })
    expect(discoveries).toBe(1)
  })
})
