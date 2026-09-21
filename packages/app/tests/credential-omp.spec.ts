import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { CredentialFileAdapter, hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { CredentialBridge, credentialSocketPath } from '../src/credential-bridge.ts'

const helper = fileURLToPath(new URL('../dist/credential-bin.mjs', import.meta.url))
describe('OMP secure helper CLI', () => {
  it('enters and reuses credentials through the real bridge without returning their values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-'))
    const socketPath = credentialSocketPath(join(home, 'state'))
    const credentials = new CredentialFileAdapter({ home })
    const askSecret = vi.fn(async () => 'omp-bridge-fixture-key')
    const bridge = new CredentialBridge({ socketPath, credentials, tui: { askSecret } })
    try {
      await bridge.start()
      for (const action of ['--replace', '--use-existing']) {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [helper, 'backend-provider', 'DeepInfra', '--omp', action], {
          env: { ...process.env, MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: socketPath }, timeout: 60_000,
        })
        expect(stdout).toContain('native permissions were verified')
        expect(stdout).toContain('Authentication has not been tested')
        expect(stdout + stderr).not.toContain('omp-bridge-fixture-key')
        expect(await hasPrivatePermissions(join(home, '.omp', 'agent', '.env'))).toBe(true)
      }
      expect(askSecret).toHaveBeenCalledTimes(1)
      expect(await readFile(join(home, '.omp', 'agent', '.env'), 'utf8')).toContain('=omp-bridge-fixture-key\n')
    } finally { await bridge.close(); await rm(home, { recursive: true, force: true }) }
  }, 120_000)
})
