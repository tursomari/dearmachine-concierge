import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DSH_NPM_VERSION,
  DSH_SOURCE_REVISION,
  INSTALLER_MODEL,
  INSTALLER_REASONING_EFFORT,
  prepareIsolatedDshHome,
} from '../src/index.ts'

describe('pinned DSH compatibility boundary', () => {
  it('pins both package and reviewed source revisions', () => {
    expect(DSH_NPM_VERSION).toBe('0.1.2-rc.1')
    expect(DSH_SOURCE_REVISION).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('writes a private isolated profile without credential values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-test-'))
    await prepareIsolatedDshHome(root)
    const patch = await readFile(join(root, 'profiles/machtiani-installer/cordis.patch.yml'), 'utf8')
    const storedSettings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain(`model: ${INSTALLER_MODEL}`)
    expect(patch).toContain('apiKeyEnv: OPENROUTER_API_KEY')
    expect(storedSettings).toContain(`reasoningEffort: ${INSTALLER_REASONING_EFFORT}`)
    expect(`${patch}\n${storedSettings}`).not.toMatch(/(?:sk-or-v1-|api[_-]?key\s*:\s*[^A-Z\s])/iu)
    expect((await stat(join(root, 'settings.yaml'))).mode & 0o077).toBe(0)
  })
})
