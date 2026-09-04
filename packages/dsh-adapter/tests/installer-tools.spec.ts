import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveInstallationOutcome } from '../src/installer-tools.ts'

describe('installer terminal outcome', () => {
  it('writes an atomic private receipt without credential material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-outcome-'))
    const path = join(root, 'state', 'outcome.json')
    await saveInstallationOutcome(path, {
      version: 1,
      outcome: 'partial',
      summary: 'The installation is safe and waiting for a human-only check.',
      remainingAction: 'Send the test message.',
      receipts: ['Nix was already installed.', 'Machtiani was installed and configured.'],
    })
    const content = await readFile(path, 'utf8')
    expect(JSON.parse(content)).toMatchObject({ outcome: 'partial', receipts: ['Nix was already installed.', 'Machtiani was installed and configured.'] })
    expect(content).not.toMatch(/API_KEY|token|credential/iu)
    expect((await stat(path)).mode & 0o077).toBe(0)
  })
})
