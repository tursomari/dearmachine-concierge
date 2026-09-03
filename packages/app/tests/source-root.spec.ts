import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInstallerAgentCredential, installerAgentPrompt, installerTurnMessage, validatedSourceRoot } from '../src/index.ts'

describe('installer source root', () => {
  it('accepts an environment credential or an isolated private DSH store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-agent-credential-'))
    await expect(assertInstallerAgentCredential(root, {})).rejects.toThrow('installer agent credential is missing')
    await expect(assertInstallerAgentCredential(root, { OPENROUTER_API_KEY: '' })).rejects.toThrow('OPENROUTER_API_KEY is empty')
    await expect(assertInstallerAgentCredential(root, { OPENROUTER_API_KEY: 'private-value' })).resolves.toBeUndefined()
    await writeFile(join(root, '.credentials.yaml'), '{"version":1,"refs":{"OPENROUTER_API_KEY":"private-value"}}\n', { mode: 0o600 })
    await expect(assertInstallerAgentCredential(root, {})).resolves.toBeUndefined()
  })

  it('gives one agent the contract and transcript-free credential bridge commands', () => {
    const prompt = installerAgentPrompt('INSTALLATION CONTRACT', '/private/credential-helper.mjs')
    expect(prompt).toContain('INSTALLATION CONTRACT')
    expect(prompt).toContain('Do not use ask_user_question')
    expect(prompt).toContain('/private/credential-helper.mjs')
    expect(prompt).toContain('llm "<selected provider>"')
    expect(prompt).toContain('email "<selected transport>"')
    expect(prompt).toContain('Never inspect, stat, source, parse, measure')
    expect(prompt).toContain('Canonical messages must be presented exactly')
    expect(prompt).toContain('system reminders')
    expect(prompt).toContain('set -o pipefail')
    expect(prompt).not.toContain('API_KEY=')
  })

  it('turns safe DSH failure codes into actionable installer messages', () => {
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'completed' })).toBeUndefined()
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'TIMEOUT' })).toContain('timed out after several attempts')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'RATE_LIMIT' })).toContain('rate-limited')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'SERVER' })).toContain('temporary connection problem')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'PI_AI_ERROR' })).toContain('could not complete this turn')
  })

  it('requires an absolute umbrella checkout containing both product components', async () => {
    await expect(validatedSourceRoot('machtiani')).rejects.toThrow('--source-root must be an absolute path')
    const root = await mkdtemp(join(tmpdir(), 'machtiani-source-root-'))
    await mkdir(join(root, 'machtiani-harness'))
    await expect(validatedSourceRoot(root)).rejects.toThrow('dearmachine')
    await mkdir(join(root, 'dearmachine'))
    await expect(validatedSourceRoot(root)).resolves.toBe(root)
  })

  it('fails early with an actionable message when the launcher has no TTY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-no-tty-'))
    await mkdir(join(root, 'machtiani-harness'))
    await mkdir(join(root, 'dearmachine'))
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('packages/app/dist/bin.mjs'), '--install', '--source-root', root], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => resolveResult({ code, stderr }))
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('Machtiani Installer needs an interactive terminal. Open a terminal and run the installer again.\n')
  })
})
