import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DSH_NPM_VERSION,
  DSH_SOURCE_REVISION,
  DshTaskExecutionError,
  INSTALLER_MODEL,
  INSTALLER_REASONING_EFFORT,
  normalizeDshSessionEvent,
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
    const profile = await readFile(join(root, 'profiles/machtiani-installer/package.json'), 'utf8')
    const storedSettings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain(`model: ${INSTALLER_MODEL}`)
    expect(patch).toContain('apiKeyEnv: OPENROUTER_API_KEY')
    expect(patch).toContain('maxRetries: 3')
    expect(patch).toContain('- PI_AI_ERROR')
    expect(storedSettings).toContain(`reasoningEffort: ${INSTALLER_REASONING_EFFORT}`)
    expect(profile).toContain('@deepseek-ai/dsh-sdk-app')
    expect(profile).not.toContain('@deepseek-ai/dsh-headless')
    expect(patch).toContain('profile: machtiani-installer')
    expect(`${patch}\n${storedSettings}`).not.toMatch(/(?:sk-or-v1-|api[_-]?key\s*:\s*[^A-Z\s])/iu)
    expect((await stat(join(root, 'settings.yaml'))).mode & 0o077).toBe(0)
  })

  it('normalizes only presentation-safe session events', () => {
    expect(normalizeDshSessionEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'considering' }, { type: 'text', text: 'Welcome.' }] } },
    })).toEqual({ type: 'assistant', text: 'Welcome.', reasoning: 'considering' })
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{"private":"omitted"}' },
    })).toEqual({ type: 'tool-start', id: 'call-1', name: 'bash' })
    expect(normalizeDshSessionEvent({
      type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } },
    })).toEqual({ type: 'tool-end', id: 'call-1', failed: false })
    expect(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })).toEqual({ type: 'turn-end', outcome: 'completed' })
  })

  it('keeps failed-task output out of the public error message', () => {
    const credential = 'adapter-test-secret'
    const error = new DshTaskExecutionError(1, {
      stdout: `response containing ${credential}`,
      stderr: `diagnostic containing ${credential}`,
    })
    expect(String(error)).not.toContain(credential)
    expect(error.privateDiagnostic()).toEqual({
      stdout: `response containing ${credential}`,
      stderr: `diagnostic containing ${credential}`,
    })
  })
})
