import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installationProgressLabel,
  installerAgentPrompt,
  installerTurnMessage,
  renderAgentEvent,
  retainInstallerAgentDiagnostic,
  type AgentToolActivityState,
  validatedSourceRoot,
} from '../src/index.ts'

describe('installer source root', () => {
  it('describes the whole guided session as installation progress', () => {
    expect(installationProgressLabel).toBe('Machtiani installation in progress')
  })

  it('keeps a safe tool purpose visible after the agent tool settles', () => {
    const rows: string[] = []
    const tui = {
      addAssistant: () => {},
      addReasoning: () => {},
      beginTool: (name: string, detail: string) => {
        rows.push(`start:${name}:${detail}`)
        return {
          succeed: (summary?: string) => { rows.push(`success:${name}:${summary ?? ''}`) },
          fail: (summary: string) => { rows.push(`failure:${name}:${summary}`) },
        }
      },
    }
    const tools = new Map<string, AgentToolActivityState>()
    renderAgentEvent(tui, tools, { type: 'tool-start', id: 'call-1', name: 'bash', detail: 'Inspect the environment' })
    renderAgentEvent(tui, tools, { type: 'tool-end', id: 'call-1', failed: false })
    renderAgentEvent(tui, tools, { type: 'tool-start', id: 'call-2', name: 'read', detail: 'docs/installation/01-environment.md' })
    renderAgentEvent(tui, tools, { type: 'tool-end', id: 'call-2', failed: true })
    expect(rows).toEqual([
      'start:bash:Inspect the environment',
      'success:bash:Inspect the environment',
      'start:read:docs/installation/01-environment.md',
      'failure:read:docs/installation/01-environment.md — Failed',
    ])
  })

  it('gives one agent only dynamic documentation, model, and credential-helper context', () => {
    const prompt = installerAgentPrompt(
      '/private/credential-helper.mjs',
      { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
      '/home/test/.config/machtiani/model-profile.json',
      {
        version: 1,
        sourceRoot: '/source/machtiani',
        documentationEntryPoint: '/source/machtiani/docs/README.md',
        umbrellaRevision: '0123456789abcdef0123456789abcdef01234567',
      },
    )
    expect(prompt).not.toContain('INSTALLATION CONTRACT')
    expect(prompt).not.toContain('ask_user_question')
    expect(prompt).toContain('/private/credential-helper.mjs')
    expect(prompt).toContain('"email"')
    expect(prompt).toContain('"backend-provider"')
    expect(prompt).not.toContain('llm "<selected provider>"')
    expect(prompt).toContain('"provider": "openai-codex"')
    expect(prompt).toContain('"model": "gpt-5.6-luna"')
    expect(prompt).toContain('"reasoningEffort": "high"')
    expect(prompt).toContain('"profile": "/home/test/.config/machtiani/model-profile.json"')
    expect(prompt).toContain('"documentationEntryPoint": "/source/machtiani/docs/README.md"')
    expect(prompt).toContain('"umbrellaRevision": "0123456789abcdef0123456789abcdef01234567"')
    expect(prompt).toContain('Begin with Stage 1 now')
    expect(prompt).not.toContain('API_KEY=')
  })

  it('turns safe DSH failure codes into actionable installer messages', () => {
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'completed' })).toBeUndefined()
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'TIMEOUT' })).toContain('timed out after several attempts')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'RATE_LIMIT' })).toContain('rate-limited')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'SERVER' })).toContain('temporary connection problem')
    expect(installerTurnMessage({ type: 'turn-end', outcome: 'error', failureCode: 'PI_AI_ERROR' })).toContain('could not complete this turn')
  })

  it('retains a private redacted diagnostic when the installer agent cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-agent-diagnostic-'))
    const path = join(root, 'state', 'installation-assistant-diagnostic.json')
    await retainInstallerAgentDiagnostic(path, new Error('startup failed with sk-private-token'), {
      stderr: 'Authorization: Bearer private-bearer-token',
    })
    const diagnostic = await readFile(path, 'utf8')
    expect(diagnostic).toContain('startup failed with [REDACTED]')
    expect(diagnostic).toContain('Authorization: Bearer [REDACTED]')
    expect(diagnostic).not.toContain('private-token')
    expect(diagnostic).not.toContain('private-bearer-token')
    expect((await stat(path)).mode & 0o077).toBe(0)
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
