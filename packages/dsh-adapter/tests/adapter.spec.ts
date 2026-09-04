import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { describe, expect, it } from 'vitest'
import {
  DSH_NPM_VERSION,
  DSH_INTERRUPT_METHOD,
  DSH_SOURCE_REVISION,
  InstallerModelSetup,
  DshTaskExecutionError,
  INSTALLER_MODEL,
  INSTALLER_REASONING_EFFORT,
  normalizeDshSessionEvent,
  prepareIsolatedDshHome,
  loadInstallerModelSelection,
  saveInstallerModelSelection,
} from '../src/index.ts'

describe('pinned DSH compatibility boundary', () => {
  it('pins both package and reviewed source revisions', () => {
    expect(DSH_NPM_VERSION).toBe('0.1.2-rc.1')
    expect(DSH_SOURCE_REVISION).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('carries the installer-owned turn interruption extension in the pinned runtime', async () => {
    expect(DSH_INTERRUPT_METHOD).toBe('session/interrupt')
    const require = createRequire(import.meta.url)
    const runtimePackage = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server/package.json')
    const runtime = await readFile(join(runtimePackage, '../lib/index.js'), 'utf8')
    expect(runtime).toContain('case "session/interrupt"')
    expect(runtime).toContain('agent.cancel({ kind: "user" })')

    const cancellations: unknown[] = []
    const agent = { id: 'agent-test', cancel: (cause: unknown) => { cancellations.push(cause) } }
    const server = new HarnessSdkJsonRpcServer({
      agents: { get: () => agent },
      on: () => () => {},
    } as never, { notify: () => {} } as never)
    Object.assign(server, { initialized: true })
    const sessions = (server as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set('session-test', { handle: { agent } })
    expect(server.interrupt({ sessionId: 'session-test' })).toEqual({})
    expect(cancellations).toEqual([{ kind: 'user' }])
  })

  it('writes a private isolated profile without credential values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-test-'))
    await prepareIsolatedDshHome(root)
    const patch = await readFile(join(root, 'profiles/machtiani-installer/cordis.patch.yml'), 'utf8')
    const profile = await readFile(join(root, 'profiles/machtiani-installer/package.json'), 'utf8')
    const storedSettings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain(`model: ${JSON.stringify(INSTALLER_MODEL)}`)
    expect(patch).not.toContain('apiKeyEnv:')
    expect(patch).toContain('id: machtiani-model-host')
    expect(patch).toContain('id: machtiani-installer-tools')
    expect(patch).toContain('id: goal\n  disabled: true')
    expect(patch).toContain('timeoutMs: 3600000')
    expect(storedSettings).toContain(`reasoningEffort: "${INSTALLER_REASONING_EFFORT}"`)
    expect(profile).toContain('@deepseek-ai/dsh-sdk-app')
    expect(profile).not.toContain('@deepseek-ai/dsh-headless')
    expect(patch).toContain('profile: machtiani-installer')
    expect(`${patch}\n${storedSettings}`).not.toMatch(/(?:sk-or-v1-|api[_-]?key\s*:\s*[^A-Z\s])/iu)
    expect((await stat(join(root, 'settings.yaml'))).mode & 0o077).toBe(0)
  })

  it('writes a selected catalog route without placing credentials in configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-selection-'))
    await prepareIsolatedDshHome(root, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
    const patch = await readFile(join(root, 'profiles/machtiani-installer/cordis.patch.yml'), 'utf8')
    const settings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain('provider: "machtiani-model-host"')
    expect(settings).toContain('model: "deepseek-v4-flash"')
    expect(settings).toContain('reasoningEffort: "high"')
    expect(`${patch}\n${settings}`).not.toContain('API_KEY')
  })

  it('uses the pinned provider catalog and DSH private credential store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-model-setup-'))
    const secret = 'model-setup-private-value'
    const setup = await InstallerModelSetup.open(root, {})
    try {
      const providers = setup.providers()
      expect(providers.some(provider => provider.id === 'openrouter')).toBe(true)
      expect(providers.some(provider => provider.id === 'deepseek')).toBe(true)
      expect(providers.some(provider => provider.id === 'openai' && !provider.authMethods[0]?.subscription)).toBe(true)
      expect(providers.find(provider => provider.id === 'openai-codex')).toEqual({
        id: 'openai-codex',
        name: 'OpenAI Codex subscription',
        authMethods: [
          { id: 'oauth', label: 'Sign in with ChatGPT in your browser', description: 'Best for a local desktop install', subscription: true },
          { id: 'device_code', label: 'Sign in with a device code', description: 'Best for SSH, containers, or headless installs', subscription: true },
        ],
      })
      expect(providers.some(provider => provider.id === 'github-copilot' && provider.authMethods[0]?.subscription)).toBe(true)
      expect(providers.find(provider => provider.id === 'anthropic-claude')).toEqual({
        id: 'anthropic-claude',
        name: 'Anthropic Claude Pro/Max subscription',
        authMethods: [{ id: 'oauth', label: 'Sign in with Claude', subscription: true }],
      })
      expect(providers.some(provider => provider.id === 'radius')).toBe(false)
      expect((await setup.modelsFor('openrouter')).find(model => model.id === 'z-ai/glm-5.3-flash')?.reasoningEfforts)
        .toEqual(['low', 'high', 'max'])
      expect((await setup.modelsFor('deepseek')).find(model => model.id === 'deepseek-v4-flash')?.reasoningEfforts)
        .toEqual(['off', 'low', 'high', 'max'])
      expect(await setup.isAuthenticated('openrouter')).toBe(false)
      await setup.authenticate('openrouter', 'api_key', {
        prompt: async prompt => {
          expect(prompt.type).toBe('secret')
          return secret
        },
        notify: () => {},
      })
      expect(await setup.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await setup.close()
    }
    const credentials = join(root, 'backends.env')
    expect((await stat(credentials)).mode & 0o077).toBe(0)
    expect(await readFile(credentials, 'utf8')).toContain(secret)

    const restarted = await InstallerModelSetup.open(root, {})
    try {
      expect(await restarted.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await restarted.close()
    }
  })

  it('builds official-runtime profiles without copying subscription credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-subscription-'))
    const home = join(root, 'home')
    const setup = await InstallerModelSetup.open(join(root, 'dsh'), { HOME: home }, { home })
    expect(setup.profileFor({ provider: 'openai-codex', model: 'gpt-test', reasoningEffort: 'high' })).toEqual({
      version: 1, driver: 'openai-codex-app-server', provider: 'openai-codex', authMethod: 'subscription',
      model: 'gpt-test', reasoningEffort: 'high', runtimeProfile: join(home, '.codex'),
    })
    expect(setup.profileFor({ provider: 'github-copilot', model: 'copilot-test' })).toEqual({
      version: 1, driver: 'github-copilot-sdk', provider: 'github-copilot', authMethod: 'subscription',
      model: 'copilot-test', runtimeProfile: join(home, '.copilot'),
    })
    expect(setup.profileFor({ provider: 'anthropic-claude', model: 'sonnet', reasoningEffort: 'high' })).toEqual({
      version: 1, driver: 'anthropic-claude-agent-sdk', provider: 'anthropic-claude', authMethod: 'subscription',
      model: 'sonnet', reasoningEffort: 'high', runtimeProfile: join(home, '.config', 'machtiani', 'claude'),
    })
  })

  it('persists only non-secret model selection in a private restart file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-model-selection-'))
    const selection = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high' }
    await saveInstallerModelSelection(root, selection)
    expect(await loadInstallerModelSelection(root)).toEqual(selection)
    expect((await stat(join(root, 'installer-model.json'))).mode & 0o077).toBe(0)
    await chmod(join(root, 'installer-model.json'), 0o644)
    await expect(loadInstallerModelSelection(root)).rejects.toThrow('private regular file')
  })

  it('imports an existing environment credential into the shared private store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-environment-auth-'))
    await chmod(root, 0o755)
    const setup = await InstallerModelSetup.open(root, { OPENROUTER_API_KEY: 'ambient-private-value' })
    try {
      expect(await setup.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await setup.close()
    }
    expect((await stat(root)).mode & 0o077).toBe(0)
    const credentials = join(root, 'backends.env')
    expect((await stat(credentials)).mode & 0o077).toBe(0)
    expect(await readFile(credentials, 'utf8')).toContain('ambient-private-value')
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
      type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: '[exit code: 124]' }] }] } },
    })).toEqual({ type: 'tool-end', id: 'call-2', failed: true })
    expect(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })).toEqual({ type: 'turn-end', outcome: 'completed' })
    expect(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'private upstream detail', code: 'TIMEOUT' } } },
    })).toEqual({ type: 'turn-end', outcome: 'error', failureCode: 'TIMEOUT' })
    expect(JSON.stringify(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'private upstream detail', code: 'UNRECOGNIZED' } } },
    }))).not.toContain('private upstream detail')
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
