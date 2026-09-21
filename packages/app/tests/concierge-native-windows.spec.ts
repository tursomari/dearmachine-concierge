import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConciergeControl } from '../src/concierge-control.ts'

// The Windows gate supplies the built native product; no user configuration or
// running supervisor is read. This tests the real CLI fallback when no pipe exists.
const binary = process.env.IXE_TEST_DEARMACHINE_NATIVE
describe.runIf(process.platform === 'win32' && Boolean(binary))('native Windows concierge observation', () => {
  it('reads absent installation and startup state in a fresh home without a supervisor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'native concierge Ω '))
    try {
      const control = defaultConciergeControl({ ...process.env, HOME: home, USERPROFILE: home,
        DEARMACHINE_NATIVE_BIN: binary, DEARMACHINE_SUPERVISOR_SOCKET: undefined })
      expect(await control.request('status')).toMatchObject({ installation: 'absent', supervisor: 'stopped', daemon: 'stopped' })
      const report = await control.readStatusReport!()
      expect(report).toContain('Managed startup at login: not configured')
      expect(report).toContain('Windows startup requires signing in')
      expect(report).not.toContain('detailed native status unavailable')
    } finally { await rm(home, { recursive: true, force: true }) }
  }, 30_000)
})
